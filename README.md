# Steam Card Farmer

This script will idle all cards for all your games by playing up to 32 games at once.

### Installation

- Install [Node.js](https://nodejs.org), you can use `winget install OpenJS.NodeJS`
- Run `git clone https://github.com/xPaw/Steam-Card-Farmer` (or [download code as zip if you don't have git](https://github.com/xPaw/Steam-Card-Farmer/archive/refs/heads/master.zip))
- Change directory to where the you extracted the contents to, `cd Steam-Card-Farmer` or type `cmd` in the explorer navigation bar
- Run `npm install --omit=dev`

### Usage

> [!IMPORTANT]
> [The "I receive a new item in my inventory" notification type must be enabled](https://store.steampowered.com/account/notificationsettings)

> [!CAUTION]
> If you have purchased a game in the past 14 days, **idling it will waive your right to a refund on Steam**.

On the command line, just type `./farm`. If you are using Windows' `cmd`, then you have to use a backslash: `.\farm`. Alternatively you can just click `farm.bat` in explorer.

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
`--concurrent-apps` | how many apps to idle at once (32 by default)
`--min-playtime` | minimum playtime in minutes without cycling (180 minutes by default)
`--cycle-delay` | how many milliseconds to wait between cycling apps (10 seconds by default)

Use `--min-playtime 0` if your account is not limited due to refunds and you get card drops from zero minutes of playtime.

### How it works

1. It checks your badges page to find which apps have drops available. Apps that are marked as private will be ignored.

2. It identifies all apps that need playtime

3. If more than half of all apps need playtime, it enters "playtime idling mode" where:
   - It prioritizes idling those under-playtime apps
   - If there aren't enough under-playtime apps to hit the concurrent limit, it fills the remaining slots with other apps that have the lowest playtime

4. If not in playtime mode (meaning most apps have sufficient playtime), it simply takes all apps that still have card drops remaining

5. For the final selection in both modes:
   - Apps are sorted by highest playtime first
   - It takes up to the maximum number of concurrent apps allowed
   - The final selection is randomly shuffled before idling begins

6. Later, this process is performed again to check whether apps can be cycled now. After idling a batch of games for 5 minutes, cycling begins. The cycling process happens gradually:
   - Starts with all apps running
   - Quits one app at a time
   - Waits 10 seconds (configurable) between each app removal
   - Continues until no apps are running

### License

Released under [the MIT license](https://opensource.org/license/mit/).
