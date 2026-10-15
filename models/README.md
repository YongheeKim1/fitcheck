# AI 보정 모델 (기기 안에서만 실행)

입혀 보기의 "AI 보정"에서 쓰는 모델이에요. 사진은 사용자 기기 밖으로 나가지 않고, 브라우저 안(onnxruntime-web, WebAssembly)에서만 실행해요.

| 파일 | 용도 | 출처 | 라이선스 |
|---|---|---|---|
| `migan_pipeline_v2.onnx` (28MB) | 새 옷이 원래 옷보다 작아 드러나는 배경 메우기 | [Picsart-AI-Research/MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN), [Hugging Face](https://huggingface.co/andraniksargsyan/migan) | 코드 MIT, 가중치 `LICENSE-MIGAN.txt`(MIT 형식, Copyright Picsart AI Research) |
| `depth_anything_v2_small_int8.onnx` (27MB) | 몸의 굴곡(깊이) 추정 → 옷에 입체 명암 | [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) Small, [onnx-community 변환판](https://huggingface.co/onnx-community/depth-anything-v2-small) (`onnx/model_quantized.onnx`) | Apache-2.0 |

실행기: [onnxruntime-web 1.20.1](https://www.npmjs.com/package/onnxruntime-web) (MIT), jsDelivr CDN에서 받아요.
