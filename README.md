# opening-drill

Chess opening drill: play your prepared line, then face replies sampled from
the Lichess opening explorer with real-game move frequencies.

## Structure

- `index.html` — markup, import map
- `css/app.css` — application styles
- `css/chessground.css` — vendored board styles + piece sprites (chessground)
- `js/app.js` — application logic (edit this)
- `js/vendor/chessground.js` — vendored board widget (chessground 9.2.1, GPL-3)
- `js/vendor/chess.js` — vendored rules engine (chess.js 1.4.0, BSD-2)

Openings come exclusively from the lichess-org/chess-openings ECO database (CC0),
fetched per ECO letter from raw.githubusercontent.com on demand.

No build step: `js/app.js` is loaded as an ES module; the import map in
`index.html` resolves `chessground` and `chess.js` to the vendored files.

Requires a (free, scopeless) Lichess API token: lichess.org/account/oauth/token

Local development: `python3 -m http.server` in this directory, then open
http://localhost:8000 (ES modules do not load over file://).
