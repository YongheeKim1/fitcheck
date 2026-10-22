# 개발용 회귀 테스트(Node)

각 파일은 앱 모듈을 직접 불러 결과를 출력합니다. 프로젝트 폴더에서:

```
for f in tests/test-*.js; do node "$f" "$PWD" | tail -1; done
```

`test-pose.js`는 마지막 줄이 "모두 통과"여야 합니다. 나머지는 출력을 이전 결과와 비교해 바뀐 곳이 없는지 봅니다.
`test-body.js`의 마지막 "hair corrected heads 6 ✗"는 예전 기대값 그대로라 원래 나옵니다(되살린 테스트 버전 차이).
