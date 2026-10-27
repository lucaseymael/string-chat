# Componentes de áudio locais

- `rnnoise-worklet.js`: `dist/rnnoise/workletProcessor.js` de `@sapphi-red/web-noise-suppressor` **0.4.1**, licença MIT. Inclui glue de `@shiguredo/rnnoise-wasm` **2022.2.0**, Apache 2.0.
- `rnnoise.wasm` e `rnnoise_simd.wasm`: distribuídos pelo mesmo pacote, baseados em Xiph RNNoise, BSD de 3 cláusulas.
- Origem: https://github.com/sapphi-red/web-noise-suppressor e https://github.com/shiguredo/rnnoise-wasm.
- Alterações no worklet: avisa a thread principal quando a inicialização termina ou falha; inicia explicitamente a MessagePort para liberar o processador ao encerrar; remove referência ao source map ausente. O modelo e o processamento RNNoise foram preservados. Desde 1.6, o adaptador publica a probabilidade de voz já calculada pelo RNNoise, a cada cinco quadros, para o detector independente de atividade de voz.
- O filtro processa áudio mono de 48 kHz no próprio navegador. Nenhum serviço de inferência ou CDN é usado em execução.

Os arquivos `*-LICENSE.txt` preservam os avisos dos autores. `THIRD-PARTY-LICENSES.txt` reúne as licenças e é incluído no executável, acessível pela ajuda do app.
