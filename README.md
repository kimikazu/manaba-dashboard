# manaba Report Dashboard

manaba の複数コースから、レポート提出状況をブラウザで集約するローカルWebアプリ。

## 必要環境

- Node.js 18 以上

## 起動手順

```bash
# 1. 依存パッケージをインストール
npm install

# 2. サーバーを起動
npm start

# 3. ブラウザで開く
open http://localhost:3000
```

## 使い方

1. `manaba URL` に大学の manaba アドレスを入力
2. 教職員 ID / パスワードを入力し **接続する**
3. コース一覧から集約したいコースを選択（年度フィルタで絞込可能）
4. **集約開始** → リアルタイムで進捗を表示しながら提出状況を取得
5. 結果テーブルで確認・絞込・ソート
6. **CSV 出力** でダウンロード

## ポート変更

```bash
PORT=8080 npm start
```
# manaba-dashboard
