# Cage Cup

Six-a-side cage football in the browser. Play the AI, or create a game and send a friend the link.

## Play on your Wi-Fi (your computer is the server)

Double-click **Start Cage Cup.applescript** and press Run, or in Terminal:

    node server.js

Open http://localhost:8080, click **Play vs Person > Create game**, and send your friend the link it shows.
Your friend needs to be on the same Wi-Fi.

## Put it online so anyone can play (free)

You need a free GitHub account and a free Render account. About 10 minutes, once.

1. **Put the code on GitHub**
   - Go to https://github.com/new, name the repository `cage-cup`, keep it Private or Public, click **Create repository**.
   - On the new repo page click **uploading an existing file**, drag in these files:
     `server.js`, `cage-cup.html`, `package.json`, `.gitignore`, `README.md`
     (you can leave out the .applescript and server.log), then click **Commit changes**.
2. **Create the web service on Render**
   - Go to https://render.com and sign up with your GitHub account.
   - Click **New > Web Service**, pick your `cage-cup` repository.
   - Settings: Runtime **Node**, Build command `npm install` (or leave blank), Start command `node server.js`,
     Instance type **Free**. Click **Create Web Service**.
3. **Play**
   - When the deploy finishes, Render shows your address, like `https://cage-cup.onrender.com`.
   - Open it, click **Play vs Person > Create game**, and send the link to anyone.

Notes
- The free Render plan sleeps after about 15 minutes with no visitors. The first visit after that takes 30 to 60 seconds to wake up.
- To update the game later, upload the new `cage-cup.html` / `server.js` to GitHub; Render redeploys automatically.
- The player who creates the game runs the match in their browser, so the friend feels a little delay over long distances.
