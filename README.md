# Steam Card Farmer

This script will idle all cards for all your games by playing up to 32 games at once.

### Installation

- Install [Node.js](https://nodejs.org)
- Run `git clone https://github.com/xPaw/Steam-Card-Farmer` (or [download code as zip](https://github.com/xPaw/Steam-Card-Farmer/archive/refs/heads/master.zip))
- Run `npm install`
- Run `npm start`

### Usage

On the command line, just type `npm start`. Optionally include your username and password as arguments, as such: `npm start steamusername steampassword`.

If not provided on the command line, it'll prompt you for your Steam username and password.

If you have purchased a game in the past 14 days, **idling it will waive your right to a refund on Steam**.

If you want to play a game while idler is running, press **Continue Launch** in Steam, and idler will wait until you finish playing to resume idling. You do not need to shut down the idler.

### License

Released under [the MIT license](https://opensource.org/license/mit/).
