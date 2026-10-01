# Star Party

A small multiplayer game for [Onceworlds](https://onceworlds.com): everyone online plays in one arena and grabs stars. Golden stars are worth five, and whoever has the most wears the crown.

Plain HTML, CSS and JavaScript, no build step. The multiplayer, saves, badges and leaderboard come from the Onceworlds SDK (`window.onceworlds`), which the platform adds to every game.

## How it works

- **Movement:** each player's position and score are their *presence*; others are drawn from it.
- **Stars:** they live in shared room state. One player (the host) owns them. Everyone else asks the host for a star, and the host checks they were next to it before it counts.
- **Saves:** best score and all-time stars follow the player to any device.

Start in `game.js`: it's one file, and every step is commented.

## Make your own

1. Fork or copy this repo, and change `slug` in `onceworlds.json` (it's your game's link, `onceworlds.com/play/<slug>`).
2. Log in to [onceworlds.com](https://onceworlds.com) with GitHub and import the repo from **Create → New game**.
3. Push. `.github/workflows/onceworlds.yml` deploys every push.

The [creator guide](https://onceworlds.com/guide) and the [docs](https://onceworlds.com/docs) cover the rest.

## License

MIT. See `LICENSE`.
