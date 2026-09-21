class VioCaptureProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.chunkSize=2048;
    this.buffer=new Float32Array(this.chunkSize);
    this.offset=0;
  }
  process(inputs){
    const input=inputs[0]&&inputs[0][0];
    if(!input)return true;
    let read=0;
    while(read<input.length){
      const take=Math.min(this.chunkSize-this.offset,input.length-read);
      this.buffer.set(input.subarray(read,read+take),this.offset);
      this.offset+=take;
      read+=take;
      if(this.offset===this.chunkSize){
        const completed=this.buffer;
        this.buffer=new Float32Array(this.chunkSize);
        this.offset=0;
        this.port.postMessage(completed,[completed.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('vio-capture',VioCaptureProcessor);
