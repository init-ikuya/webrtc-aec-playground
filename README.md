# webrtc-aec-playground

WebRTC `echoCancellation` constraint の AEC 収束挙動をデバイス・ブラウザ別に検証するためのツール。

## 機能

- テスト音源の再生（スイープ / ホワイトノイズ / 音声風信号）
- `echoCancellation` / `noiseSuppression` / `autoGainControl` の on/off 切り替え
- マイク入力の波形（時間領域）とスペクトログラム（周波数領域）のリアルタイム表示
- RMS レベル（dB）のリアルタイム表示
- 録音・ダウンロード機能（on/off 比較用）
- `MediaTrackSettings` / `MediaTrackCapabilities` の表示

## 使い方

### ローカル（Mac Chrome での検証）

`getUserMedia` は `localhost` であれば HTTP でも動作します。

```bash
npx serve .
```

`http://localhost:3000` にアクセスしてください。

### モバイルデバイス（Android Chrome / iPad Safari での検証）

モバイルデバイスから `getUserMedia` を使うには **HTTPS** が必要です。以下のいずれかの方法でアクセスしてください。

**方法 1: ngrok でトンネル**

```bash
npx serve .
# 別ターミナルで
ngrok http 3000
```

表示された `https://xxxx.ngrok-free.app` の URL にモバイルデバイスからアクセスします。

**方法 2: GitHub Pages（リポジトリを public にした場合）**

リポジトリを public に変更後、GitHub Pages を有効にすれば `https://init-ikuya.github.io/webrtc-aec-playground/` でアクセスできます。

## 検証手順

1. テスト音源を選んで「再生」（スピーカーから音が出ます）
2. `echoCancellation` を **off** にして「マイク開始」→ 波形を確認 → 「録音開始」で記録
3. マイクを一度停止し、`echoCancellation` を **on** にして再度「マイク開始」→ 同様に記録
4. 2つの録音を比較して AEC の効果・収束の様子を確認

## 対象環境

| デバイス | ブラウザ | AEC 実装 |
|---------|---------|---------|
| Mac | Chrome | WebRTC AEC3 (ソフトウェア) |
| Android | Chrome | WebRTC AEC3 (モバイル版) |
| iPad | Safari | CoreAudio VoiceProcessingIO |
