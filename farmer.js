#!/usr/bin/env node

const SteamUser = require('steam-user');
const prompt = require('prompt');
const Cheerio = require('cheerio');

const client = new SteamUser();

let request = require('request');

const g_Jar = request.jar();
request = request.defaults({ jar: g_Jar });

let g_Page = 1;
let g_CheckTimer;
let g_OwnedApps = [];

function log(message) {
	const date = new Date();
	const time = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];

	for (let i = 1; i < 6; i++) {
		if (time[i] < 10) {
			time[i] = `0${time[i]}`;
		}
	}

	console.log(`${time[0]}-${time[1]}-${time[2]} ${time[3]}:${time[4]}:${time[5]} - ${message}`);
}

function shutdown(code) {
	client.logOff();
	client.once('disconnected', () => {
		process.exit(code);
	});

	setTimeout(() => {
		process.exit(code);
	}, 500);
}

function checkCardApps() {
	if (g_CheckTimer) {
		clearTimeout(g_CheckTimer);
	}

	log('Checking card drops...');

	client.webLogOn();
	client.once('webSession', (sessionID, cookies) => {
		cookies.forEach((cookie) => {
			g_Jar.setCookie(cookie, 'https://steamcommunity.com');
		});

		request(`https://steamcommunity.com/my/badges/?l=english&p=${g_Page}`, (err, response, body) => {
			if (err || response.statusCode !== 200) {
				log(`Couldn't request badge page: ${err || `HTTP error ${response.statusCode}`}`);
				checkCardsInSeconds(30);
				return;
			}

			if (body.includes('g_steamID = false')) {
				log('Badge page loaded, but its logged out');
				checkCardsInSeconds(30);
				return;
			}

			let appsWithDrops = 0;
			let totalDropsLeft = 0;
			let appLaunched = false;

			const $ = Cheerio.load(body);
			const infolines = $('.progress_info_bold');

			for (let i = 0; i < infolines.length; i++) {
				const match = $(infolines[i]).text().match(/(\d+)/);

				const href = $(infolines[i]).closest('.badge_row').find('.badge_title_playgame a').attr('href');
				if (!href) {
					continue;
				}

				const urlparts = href.split('/');
				const appid = parseInt(urlparts[urlparts.length - 1], 10);
				const drops = parseInt(match[1], 10);

				if (!match || !drops || g_OwnedApps.indexOf(appid) === -1) {
					continue;
				}

				appsWithDrops++;
				totalDropsLeft += drops;

				if (!appLaunched) {
					appLaunched = true;

					let title = $(infolines[i]).closest('.badge_row').find('.badge_title');
					title.find('.badge_view_details').remove();
					title = title.text().trim();

					log(`Idling app ${appid} "${title}" - ${drops} drop${drops === 1 ? '' : 's'} remaining`);
					client.gamesPlayed(appid);
				}
			}

			log(`${totalDropsLeft} card drop${totalDropsLeft === 1 ? '' : 's'} remaining across ${appsWithDrops} app${appsWithDrops === 1 ? '' : 's'} (Page ${g_Page})`);
			if (totalDropsLeft === 0) {
				if ($('.badge_row').length > 0) {
					log(`No drops remaining on page ${g_Page}`);
					g_Page++;
					log(`Checking page ${g_Page}`);
					checkMinPlaytime();
				} else {
					log('All card drops recieved!');
					log('Shutting Down.');
					shutdown(0);
				}
			} else {
				checkCardsInSeconds(1200); // 20 minutes to be safe, we should automatically check when Steam notifies us that we got a new item anyway
			}
		});
	});
}

function checkMinPlaytime() {
	log('Checking app playtime...');

	client.webLogOn();
	client.once('webSession', (sessionID, cookies) => {
		cookies.forEach((cookie) => {
			g_Jar.setCookie(cookie, 'https://steamcommunity.com');
		});

		request(`https://steamcommunity.com/my/badges/?p=${g_Page}`, (err, response, body) => {
			if (err || response.statusCode !== 200) {
				log(`Couldn't request badge page: ${err || `HTTP error ${response.statusCode}`}. Retrying in 10 seconds...`);
				setTimeout(checkMinPlaytime, 10000);
				return;
			}

			const lowHourApps = [];

			const $ = Cheerio.load(body);
			$('.badge_row').each((index, element) => {
				const row = $(element);
				const overlay = row.find('.badge_row_overlay');
				if (!overlay) {
					return;
				}

				const match = overlay.attr('href').match(/\/gamecards\/(\d+)/);
				if (!match) {
					return;
				}

				const appid = parseInt(match[1], 10);

				let name = row.find('.badge_title');
				name.find('.badge_view_details').remove();
				name = name.text().replace(/\n/g, '').replace(/\r/g, '').replace(/\t/g, '')
					.trim();

				// Find out if we have drops left
				let drops = row.find('.progress_info_bold').text().match(/(\d+)/);
				if (!drops) {
					return;
				}

				drops = parseInt(drops[1], 10);
				if (Number.isNaN(drops) || drops < 1) {
					return;
				}

				// Find out playtime
				let playtime = row.find('.badge_title_stats').html().match(/(\d+\.\d+)/);
				if (!playtime) {
					playtime = 0.0;
				} else {
					playtime = parseFloat(playtime[1], 10);
					if (Number.isNaN(playtime)) {
						playtime = 0.0;
					}
				}

				if (playtime < 2.0) {
					// It needs hours!

					lowHourApps.push({
						appid,
						name,
						playtime,
					});
				} else {
					g_OwnedApps.push(appid);
				}
			});

			if (lowHourApps.length > 0) {
				let minPlaytime = 2.0;

				lowHourApps.forEach((app) => {
					if (app.playtime < minPlaytime) {
						minPlaytime = app.playtime;
					}

					log(`App ${app.appid} - ${app.name} - Playtime: ${app.playtime}`);
				});

				const lowAppsToIdle = lowHourApps.map(app => app.appid);

				if (lowAppsToIdle.length < 1) {
					checkCardApps();
				} else {
					g_OwnedApps = g_OwnedApps.concat(lowAppsToIdle);
					client.gamesPlayed(lowAppsToIdle);
					log(`Idling ${lowAppsToIdle.length} app${lowAppsToIdle.length === 1 ? '' : 's'} up to 2 hours.`);
					log(`You likely won't receive any card drops in this time.\nThis will take ${2.0 - minPlaytime} hours.`);
					setTimeout(() => {
						client.gamesPlayed([]);
						checkCardApps();
					}, (1000 * 60 * 60 * (2.0 - minPlaytime)));
				}
			} else {
				checkCardApps();
			}
		});
	});
}

function checkCardsInSeconds(seconds) {
	g_CheckTimer = setTimeout(checkCardApps, (1000 * seconds));
}

let argsStartIdx = 2;
if (process.argv[0] === 'steamcardfarmer') {
	argsStartIdx = 1;
}

if (process.argv.length === argsStartIdx + 2) {
	log('Reading Steam credentials from command line');
	client.logOn({
		accountName: process.argv[argsStartIdx],
		password: process.argv[argsStartIdx + 1],
	});
} else {
	prompt.start();
	prompt.get({
		properties: {
			username: {
				required: true,
			},
			password: {
				hidden: true,
				required: true,
			},
		},
	}, (err, result) => {
		if (err) {
			log(`Error: ${err}`);
			shutdown(1);
			return;
		}

		log('Initializing Steam client...');
		client.logOn({
			accountName: result.username,
			password: result.password,
		});
	});
}

process.on('SIGINT', () => {
	log('Logging off and shutting down');
	shutdown(0);
});

client.on('loggedOn', () => {
	log('Logged into Steam!');
	checkMinPlaytime();
});

client.on('error', (e) => {
	log(`Error: ${e}`);
});

client.on('newItems', (count) => {
	if (g_OwnedApps.length === 0 || count === 0) {
		return;
	}

	log(`Got notification of new inventory items: ${count} new item${count === 1 ? '' : 's'}`);
	checkCardApps();
});
