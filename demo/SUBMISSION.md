# G’s提出文（貼り付け用）

## TSUNAGU — 次のご連絡を、あなたの言葉で。

営業が手で顧客を探し、会話を読み返し、追客文を作る作業を減らすアシスタントです。議事録・商品情報の更新を捉え、顧客の希望と照合し、理由付きの連絡案を営業本人へ届けます。営業はLINEから編集・承認・見送りを選びます。

**実機体験URL： https://tsunagu-gs-integration.shimoryo.workers.dev/demo**

Googleアカウントと個人LINEがあれば、運営の同席なしで試せます。初回の目安は10〜15分。営業役と顧客役を兼ねて、本人確認した自分のLINEだけにメッセージを送ります。

- 営業役の通知LINE： https://lin.ee/yV6rgH7 （@876qqbck）
- 顧客役のLINE： https://line.me/R/ti/p/%40302klzlz （@302klzlz）
- 添付用PDF： https://tsunagu-gs-integration.shimoryo.workers.dev/demo-guide.pdf
- 手順書： https://tsunagu-gs-integration.shimoryo.workers.dev/demo-guide.html

**試してほしいこと：** Googleログイン → 2つのLINEを追加・本人確認 → 議事録を自分に紐付け → 希望に合う物件を追加 → 自動で届く文案を編集・承認 → 自分のLINEで受信 → 文中のリンクからTimeRex予約 → 予約通知を受信 → 予約を取り消す。

見どころは、生成ボタンを毎回押すことではなく、情報の変化から連絡案が準備されることです。希望に合わない物件や古い情報では送らず、営業の最終承認を待ちます。編集や見送りの記録は、文体・事実訂正・顧客固有の事情に分けて次回へ反映します。

共通の架空素材と、自分用の議事録・物件をその場で使えます。TimeRexは実際の日時を確保するため、体験後に必ず取消をお願いします。約10人向けの体験枠を用意しています。

技術：React / Hono / TypeScript / Cloudflare Workers・D1 / Google OAuth・Drive・Sheets / LINE Messaging API / TimeRex Webhook / OpenAI。文案生成は根拠を検証し、送信時にも顧客・在庫・会話の更新を確認します。

ソースコード： https://github.com/Shimochaan/tsunagu-gs-demo

## 管理・営業・運営の全画面見学

**[demo@example.com でログイン](https://tsunagu-gs-showcase.shimoryo.workers.dev/login)** — パスワード・確認コードは不要です。公開の架空データを使った見学用アカウントです。

ログイン後の「画面一覧・導入フロー」から、今日の提案・顧客・面談結果・接続設定・導入設定・運営管理など、全19画面へ移れます。各画面に役割と通常の操作を表示します。保存・送信・外部接続は停止しています。自分のLINEへの実送信には、Googleログインの体験画面を使ってください。

[全画面の役割・企業への導入フロー](SCREENS-AND-ONBOARDING.md)
