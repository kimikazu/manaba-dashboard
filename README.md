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

レポートタイトルのリンクは教員向けの一括回収・採点ページを開きます。行内の `提出確認` から個別確認ページ、`学生向け` から学生表示ページも開けます。

## ポート変更

```bash
PORT=8080 npm start
```

## 取得速度の調整

manaba へのアクセス間隔と並列数は環境変数で調整できます。通常は既定値のままで使えます。

```bash
# 例: レポート件数取得を4並列、各アクセス後の待ち時間を100msにする
MANABA_REPORT_CONCURRENCY=4 MANABA_REQUEST_DELAY_MS=100 npm start
```

- `MANABA_REPORT_CONCURRENCY`: レポート件数取得の並列数。既定値は `3`、上限は `6`
- `MANABA_REQUEST_DELAY_MS`: 各アクセス後の待ち時間。既定値は `150`
- `MANABA_TIMEOUT_MS`: 1リクエストのタイムアウト。既定値は `20000`
- `MANABA_REQUEST_RETRIES`: 一時的な失敗時の再試行回数。既定値は `2`
# manaba-dashboard
