# Chatcord

Chat estilo Discord, auto-hospedado: servidores, canais de texto e de voz, **chamadas de voz, vídeo e compartilhamento de tela** via WebRTC. Sem build, sem banco de dados — só Node.js.

## Recursos

- Servidores e canais (texto e voz), histórico de mensagens salvo em `data/data.json`
- Chamada de voz com cancelamento de eco, supressão de ruído e indicador de quem está falando
- Vídeo (câmera) e compartilhamento de tela com áudio do sistema/aba (quando o navegador permite)
- Resolução selecionável para câmera e tela: **360p, 480p, 720p, 1080p, 1440p, 4K** (e "Nativa" para tela), com 5–60 FPS
- Troca de microfone, câmera e saída de áudio durante a chamada
- Mudo, ensurdecer, fixar um participante (clique) e tela cheia (duplo clique)
- Reconexão ICE automática e "perfect negotiation" (renegociação sem conflitos)

## Como rodar

```bash
npm install
npm start
# abra http://localhost:3000
```

Variáveis em `.env.example` (`PORT`, `SSL_KEY`, `SSL_CERT`, `STUN_URLS`, `TURN_*`). Exporte-as no ambiente ou use `node --env-file=.env server.js` (Node 20.6+).

Com Docker:

```bash
docker build -t chatcord .
docker run -p 3000:3000 -v chatcord-data:/app/data chatcord
```

## Importante para funcionar com outras pessoas

1. **HTTPS é obrigatório** para câmera, microfone e tela fora de `localhost`. Use um proxy reverso (Caddy, Nginx) com certificado válido ou defina `SSL_KEY` e `SSL_CERT`. O proxy precisa repassar WebSocket.
2. **TURN**: STUN basta em redes simples. Em 4G, Wi-Fi corporativo ou NAT simétrico a chamada só conecta com um servidor TURN. Instale o [coturn](https://github.com/coturn/coturn) e configure `TURN_URL`, `TURN_USER` e `TURN_PASS`.
3. Abra no firewall a porta do app (TCP) e as do TURN (3478 e a faixa de relay UDP).

## Limitações conhecidas

- **Topologia em malha (mesh)**: cada participante envia seu vídeo diretamente a todos os outros. Funciona bem até ~5–6 pessoas; com vídeo/tela em 1080p+ o limite cai. Para salas grandes, troque o transporte por uma SFU (LiveKit, mediasoup).
- A resolução enviada nunca passa da capacidade da câmera ou da tela, e a qualidade real depende de CPU e banda. 4K a 60 FPS é pesado.
- **Sem autenticação**: o nome é apenas um apelido e qualquer pessoa com acesso à URL entra e cria canais. Não exponha na internet sem uma camada de autenticação (proxy com login, VPN etc.).
- O histórico guarda as últimas 200 mensagens por canal em um arquivo JSON.
- Safari/iOS não captura áudio do sistema na tela, e o iOS não suporta compartilhar tela.

## Estrutura

```
server.js        HTTP estático + WebSocket (chat, canais, sinalização WebRTC)
public/          index.html, style.css, app.js (cliente)
Dockerfile       imagem de produção
.github/         CI (checagem de sintaxe)
```

## Licença

MIT
