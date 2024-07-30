# Steam Card Farmer

This script will idle all cards for all your games by playing up to 32 games at once.

### Installation

- Install [Node.js](https://nodejs.org)
- Run `git clone https://github.com/xPaw/Steam-Card-Farmer` (or [download code as zip](https://github.com/xPaw/Steam-Card-Farmer/archive/refs/heads/master.zip))
- Run `npm install`
- Run `npm start`

### Usage

> [!IMPORTANT]
> [The "I receive a new item in my inventory" notification type must be enabled](https://store.steampowered.com/account/notificationsettings)

On the command line, just type `npm start`.

If you have purchased a game in the past 14 days, **idling it will waive your right to a refund on Steam**.

If you want to play a game while idler is running, press **Continue Launch** in Steam, and idler will wait until you finish playing to resume idling. You do not need to shut down the idler.

#### Optional arguments

For example: `npm start -- --username hello --min-playtime 120`

Name | Description
---- | -----------
`--username` or `-u` | steam username
`--password` or `-p` | steam password
`--concurrent-apps` | how many apps to idle at once
`--min-playtime` | minimum playtime in minutes without cycling
`--cycle-delay` | how many milliseconds to wait between cycling apps

### License

Released under [the MIT license](https://opensource.org/license/mit/).
