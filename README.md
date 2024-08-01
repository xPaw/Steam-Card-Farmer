# Steam Card Farmer

This script will idle all cards for all your games by playing up to 32 games at once.

### Installation

- Install [Node.js](https://nodejs.org), you can use `winget install OpenJS.NodeJS`
- Run `git clone https://github.com/xPaw/Steam-Card-Farmer` (or [download code as zip if you don't have git](https://github.com/xPaw/Steam-Card-Farmer/archive/refs/heads/master.zip))
- Run `npm install --omit=dev`

### Usage

> [!IMPORTANT]
> [The "I receive a new item in my inventory" notification type must be enabled](https://store.steampowered.com/account/notificationsettings)

> [!CAUTION]
> If you have purchased a game in the past 14 days, **idling it will waive your right to a refund on Steam**.

On the command line, just type `./farm`.
On Windows, you can click `farm.bat`.

If you want to play a game while idler is running, press **Continue Launch** in Steam, and idler will wait until you finish playing to resume idling. You do not need to shut down the idler.

### Arguments

If no arguments are provided, it will ask for username and password interactively.
Once logged in, it will store the refresh token in data folder, which will not ask for your password again.

If the token was already stored, you can skip the interaction by passing username as an argument.

For example: `./farm -u hello --min-playtime 120`

Name | Description
---- | -----------
`--username` or `-u` | steam username
`--password` or `-p` | steam password
`--concurrent-apps` | how many apps to idle at once
`--min-playtime` | minimum playtime in minutes without cycling
`--cycle-delay` | how many milliseconds to wait between cycling apps

Use `--min-playtime 0` if your account is not limited due to refunds and you get card drops from zero minutes of playtime.

### License

Released under [the MIT license](https://opensource.org/license/mit/).
