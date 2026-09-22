cmake_minimum_required(VERSION 3.22.1)

project(vio_audio LANGUAGES CXX)

find_package(oboe REQUIRED CONFIG)

add_library(
    vio_audio
    SHARED
    vio_oboe_capture.cpp
)

target_compile_features(vio_audio PRIVATE cxx_std_17)

find_library(log_lib log)

target_link_libraries(
    vio_audio
    PRIVATE
    oboe::oboe
    ${log_lib}
)
