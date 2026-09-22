#include <jni.h>
#include <oboe/Oboe.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr uint64_t kRingCapacity = 65536;
constexpr uint64_t kBacklogTrimThreshold = 8192;
constexpr uint64_t kBacklogKeepFrames = 2048;

class OboeCaptureEngine final
        : public oboe::AudioStreamDataCallback,
          public oboe::AudioStreamErrorCallback {
public:
    int32_t start() {
        std::lock_guard<std::mutex> lock(mLifecycleMutex);
        stopLocked();

        mReadIndex.store(0, std::memory_order_relaxed);
        mWriteIndex.store(0, std::memory_order_relaxed);
        mDroppedFrames.store(0, std::memory_order_relaxed);
        mLastError.store(0, std::memory_order_relaxed);
        mSampleRate.store(0, std::memory_order_relaxed);
        mFramesPerBurst.store(0, std::memory_order_relaxed);
        mBufferCapacity.store(0, std::memory_order_relaxed);
        mBackendName = "oboe-unavailable";

        const Attempt attempts[] = {
            { oboe::SharingMode::Exclusive, oboe::InputPreset::Unprocessed, "unprocessed" },
            { oboe::SharingMode::Exclusive, oboe::InputPreset::VoiceRecognition, "voice-recognition" },
            { oboe::SharingMode::Shared, oboe::InputPreset::Unprocessed, "unprocessed" },
            { oboe::SharingMode::Shared, oboe::InputPreset::VoiceRecognition, "voice-recognition" }
        };

        oboe::Result lastResult = oboe::Result::ErrorUnavailable;
        for (const auto &attempt : attempts) {
            std::shared_ptr<oboe::AudioStream> candidate;
            oboe::AudioStreamBuilder builder;
            builder.setDirection(oboe::Direction::Input);
            builder.setPerformanceMode(oboe::PerformanceMode::LowLatency);
            builder.setSharingMode(attempt.sharingMode);
            builder.setFormat(oboe::AudioFormat::Float);
            builder.setFormatConversionAllowed(true);
            builder.setChannelCount(oboe::ChannelCount::Mono);
            builder.setInputPreset(attempt.inputPreset);
            builder.setDataCallback(this);
            builder.setErrorCallback(this);

            lastResult = builder.openStream(candidate);
            if (lastResult != oboe::Result::OK || !candidate) {
                continue;
            }

            mStream = candidate;
            mRunning.store(true, std::memory_order_release);
            mSampleRate.store(candidate->getSampleRate(), std::memory_order_relaxed);
            mFramesPerBurst.store(candidate->getFramesPerBurst(), std::memory_order_relaxed);
            mBufferCapacity.store(candidate->getBufferCapacityInFrames(), std::memory_order_relaxed);
            mBackendName = makeBackendName(*candidate, attempt.presetName);

            lastResult = candidate->requestStart();
            if (lastResult == oboe::Result::OK) {
                return 0;
            }

            mRunning.store(false, std::memory_order_release);
            candidate->close();
            mStream.reset();
        }

        mLastError.store(static_cast<int32_t>(lastResult), std::memory_order_release);
        mBackendName = "oboe-failed";
        return static_cast<int32_t>(lastResult);
    }

    void stop() {
        std::lock_guard<std::mutex> lock(mLifecycleMutex);
        stopLocked();
    }

    int32_t read(float *output, int32_t maxFrames, int32_t timeoutMs) {
        if (output == nullptr || maxFrames <= 0) {
            return -1;
        }

        const auto timeout = std::chrono::milliseconds(std::max(0, timeoutMs));
        const auto deadline = std::chrono::steady_clock::now() + timeout;

        while (true) {
            uint64_t read = mReadIndex.load(std::memory_order_relaxed);
            const uint64_t write = mWriteIndex.load(std::memory_order_acquire);
            uint64_t available = write - read;

            if (available > kBacklogTrimThreshold) {
                const uint64_t skipped = available - kBacklogKeepFrames;
                read += skipped;
                mReadIndex.store(read, std::memory_order_release);
                mDroppedFrames.fetch_add(skipped, std::memory_order_relaxed);
                available = kBacklogKeepFrames;
            }

            if (available > 0) {
                const int32_t count = static_cast<int32_t>(
                        std::min<uint64_t>(available, static_cast<uint64_t>(maxFrames)));
                for (int32_t i = 0; i < count; ++i) {
                    output[i] = mRing[(read + static_cast<uint64_t>(i)) % kRingCapacity];
                }
                mReadIndex.store(read + static_cast<uint64_t>(count), std::memory_order_release);
                return count;
            }

            if (!mRunning.load(std::memory_order_acquire)) {
                return mLastError.load(std::memory_order_acquire) == 0 ? -2 : -3;
            }

            if (timeoutMs <= 0 || std::chrono::steady_clock::now() >= deadline) {
                return 0;
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }

    bool isRunning() const {
        return mRunning.load(std::memory_order_acquire);
    }

    int32_t sampleRate() const {
        return mSampleRate.load(std::memory_order_relaxed);
    }

    int32_t framesPerBurst() const {
        return mFramesPerBurst.load(std::memory_order_relaxed);
    }

    int32_t bufferCapacity() const {
        return mBufferCapacity.load(std::memory_order_relaxed);
    }

    int64_t droppedFrames() const {
        return static_cast<int64_t>(mDroppedFrames.load(std::memory_order_relaxed));
    }

    int32_t lastErrorCode() const {
        return mLastError.load(std::memory_order_relaxed);
    }

    std::string backendName() const {
        std::lock_guard<std::mutex> lock(mLifecycleMutex);
        return mBackendName;
    }

    oboe::DataCallbackResult onAudioReady(
            oboe::AudioStream *,
            void *audioData,
            int32_t numFrames) override {
        if (!mRunning.load(std::memory_order_relaxed) || audioData == nullptr || numFrames <= 0) {
            return oboe::DataCallbackResult::Continue;
        }

        const auto *input = static_cast<const float *>(audioData);
        const uint64_t write = mWriteIndex.load(std::memory_order_relaxed);
        const uint64_t read = mReadIndex.load(std::memory_order_acquire);
        const uint64_t used = write - read;
        const uint64_t freeFrames = used < kRingCapacity ? kRingCapacity - used : 0;
        const uint64_t writable = std::min<uint64_t>(
                static_cast<uint64_t>(numFrames),
                freeFrames);

        for (uint64_t i = 0; i < writable; ++i) {
            mRing[(write + i) % kRingCapacity] = input[i];
        }

        if (writable > 0) {
            mWriteIndex.store(write + writable, std::memory_order_release);
        }
        if (writable < static_cast<uint64_t>(numFrames)) {
            mDroppedFrames.fetch_add(
                    static_cast<uint64_t>(numFrames) - writable,
                    std::memory_order_relaxed);
        }

        return oboe::DataCallbackResult::Continue;
    }

    void onErrorAfterClose(oboe::AudioStream *, oboe::Result error) override {
        mLastError.store(static_cast<int32_t>(error), std::memory_order_release);
        mRunning.store(false, std::memory_order_release);
    }

private:
    struct Attempt {
        oboe::SharingMode sharingMode;
        oboe::InputPreset inputPreset;
        const char *presetName;
    };

    static std::string makeBackendName(
            const oboe::AudioStream &stream,
            const char *presetName) {
        std::string result = "oboe-";
        result += stream.getAudioApi() == oboe::AudioApi::AAudio ? "aaudio" : "opensles";
        result += stream.getSharingMode() == oboe::SharingMode::Exclusive
                ? "-exclusive"
                : "-shared";
        result += stream.getPerformanceMode() == oboe::PerformanceMode::LowLatency
                ? "-low-latency"
                : "-standard";
        result += "-";
        result += presetName;
        return result;
    }

    void stopLocked() {
        mRunning.store(false, std::memory_order_release);
        auto stream = mStream;
        mStream.reset();
        if (stream) {
            stream->requestStop();
            stream->close();
        }
    }

    mutable std::mutex mLifecycleMutex;
    std::shared_ptr<oboe::AudioStream> mStream;
    std::array<float, kRingCapacity> mRing{};
    std::atomic<uint64_t> mReadIndex{0};
    std::atomic<uint64_t> mWriteIndex{0};
    std::atomic<uint64_t> mDroppedFrames{0};
    std::atomic<bool> mRunning{false};
    std::atomic<int32_t> mLastError{0};
    std::atomic<int32_t> mSampleRate{0};
    std::atomic<int32_t> mFramesPerBurst{0};
    std::atomic<int32_t> mBufferCapacity{0};
    std::string mBackendName{"oboe-unavailable"};
};

OboeCaptureEngine gCapture;

jstring toJString(JNIEnv *env, const std::string &value) {
    return env->NewStringUTF(value.c_str());
}

} // namespace

extern "C" JNIEXPORT void JNICALL
Java_com_anuppaul_vio_NativeOboeCapture_nativeConfigureDefaults(
        JNIEnv *,
        jclass,
        jint sampleRate,
        jint framesPerBurst) {
    if (sampleRate > 0) {
        oboe::DefaultStreamValues::SampleRate = sampleRate;
    }
    if (framesPerBurst > 0) {
        oboe::DefaultStreamValues::FramesPerBurst = framesPerBurst;
    }
    oboe::DefaultStreamValues::ChannelCount = 1;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_anuppaul_vio_NativeOboeCapture_nativeStart(
        JNIEnv *,
        jclass) {
    return gCapture.start();
}

extern "C" JNIEXPORT void JNICALL
Java_com_anuppaul_vio_NativeOboeCapture_nativeStop(
        JNIEnv *,
        jclass) {
    gCapture.stop();
}

extern "C" JNIEXPORT jint JNICALL
Java_com_anuppaul_vio_NativeOboeCapture_nativeRead(
        JNIEnv *env,
        jclass,
        jfloatArray output,
        jint maxFrames,
        jint timeoutMs) {
    if (output == nullptr) {
        return -1;
    }

    const jsize arrayLength = env->GetArrayLength(output);
    const int32_t countLimit = std::min<int32_t>(
            std::max<int32_t>(0, maxFrames),
            static_cast<int32_t>(arrayLength));
    if (countLimit <= 0) {
        return -1;
    }

    thread_local std::vector<float> scratch;
    if (static_cast<int32_t>(scratch.size()) < countLimit) {
        scratch.resize(static_cast<size_t>(countLimit));
    }

    const int32_t count = gCapture.read(scratch.data(), countLimit, timeoutMs);
    if (count > 0) {
        env->SetFloatArrayRegion(output, 0, count, scratch.data());
    }
    return count;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_anuppaul_vio_NativeOboeCapture_nativeIsRunning(
        JNIEnv *,
        jclass) {
    return gCapture.isRunning() ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_anuppaul_vio_NativeOboeCapture_nativeGetSampleRate(
        JNIEnv *,
        jclass) {
    return gCapture.sampleRate();
}

extern "C" JNIEXPORT jint JNICALL
Java_com_anuppaul_vio_NativeOboeCapture_nativeGetFramesPerBurst(
        JNIEnv *,
        jclass) {
    return gCapture.framesPerBurst();
}

extern "C" JNIEXPORT jint JNICALL
Java_com_anuppaul_vio_NativeOboeCapture_nativeGetBufferCapacityFrames(
        JNIEnv *,
        jclass) {
    return gCapture.bufferCapacity();
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_anuppaul_vio_NativeOboeCapture_nativeGetDroppedFrames(
        JNIEnv *,
        jclass) {
    return static_cast<jlong>(gCapture.droppedFrames());
}

extern "C" JNIEXPORT jint JNICALL
Java_com_anuppaul_vio_NativeOboeCapture_nativeGetRingCapacityFrames(
        JNIEnv *,
        jclass) {
    return static_cast<jint>(kRingCapacity);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_anuppaul_vio_NativeOboeCapture_nativeGetLastErrorCode(
        JNIEnv *,
        jclass) {
    return gCapture.lastErrorCode();
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_anuppaul_vio_NativeOboeCapture_nativeGetBackendName(
        JNIEnv *env,
        jclass) {
    return toJString(env, gCapture.backendName());
}
