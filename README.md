# Steam Card Farmer

## Requires latest Node.js version.

Designed for advanced users.

# Installation

- Install [Node.js](https://nodejs.org)
- Clone this repository
- Run `npm install`
- Run `node farmer.js`

# Usage

On the command line, just type `node farmer.js`. Optionally include your username and password as arguments, as such: `node farmer.js steamusername steampassword`.

If not provided on the command line, it'll prompt you for your Steam username and password.

If you have games with remaining drops which have less than 2 hours of playtime, the app will first mass-idle all of them up to 2 hours. Then it will start switching through them to get card drops. If you have purchased a game in the past 14 days, **idling it will waive your right to a refund on Steam**.

It'll automatically switch through all games you have with remaining card drops (it checks every 20 minutes or immediately when a new item is received). One could theoretically mass-idle all games at once, but it takes just as long and this way doesn't rack up unnecessary fake playtime.

## License

Released under [the MIT license](http://opensource.org/licenses/MIT).
