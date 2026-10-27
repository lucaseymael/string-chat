// MediaPipe is loaded from bundled local assets. Frames never leave this worker/app.
importScripts('./vendor/mediapipe/vision_bundle.js');
let segmenter;
self.onmessage=async({data})=>{
  try{
    if(data.type==='init'){
      const files=await Vision.FilesetResolver.forVisionTasks(new URL('./vendor/mediapipe/wasm',self.location.href).href);
      segmenter=await Vision.ImageSegmenter.createFromOptions(files,{baseOptions:{modelAssetPath:new URL('./vendor/mediapipe/selfie_segmenter.tflite',self.location.href).href,delegate:'CPU'},runningMode:'VIDEO',outputCategoryMask:true,outputConfidenceMasks:false});
      self.postMessage({type:'ready'});
    }else if(data.type==='frame'&&segmenter){
      try{segmenter.segmentForVideo(data.frame,data.time,result=>{const mask=result.categoryMask,values=mask.getAsUint8Array().slice();self.postMessage({type:'frame',frame:data.frame,mask:values,width:mask.width,height:mask.height},[data.frame,values.buffer]);});}
      catch(e){data.frame.close();throw e;}
    }else if(data.type==='close'){segmenter?.close();segmenter=null;self.close();}
  }catch(e){self.postMessage({type:'error',message:String(e.message||e)});}
};
