#!/usr/bin/env node

var SteamUser = require('steam-user');
var prompt = require('prompt');
var request = require('request');
var Cheerio = require('cheerio');

var client = new SteamUser();

var g_Jar = request.jar();
request = request.defaults({"jar": g_Jar});
var g_Page = 1;
var g_CheckTimer;
var g_OwnedApps = [];

function log(message) {
	var date = new Date();
	var time = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
	
	for(var i = 1; i < 6; i++) {
		if(time[i] < 10) {
			time[i] = '0' + time[i];
		}
	}
	
	console.log(time[0] + '-' + time[1] + '-' + time[2] + ' ' + time[3] + ':' + time[4] + ':' + time[5] + ' - ' + message);
}

var argsStartIdx = 2;
if(process.argv[0] == 'steamcardfarmer') {
	argsStartIdx = 1;
}

if(process.argv.length == argsStartIdx + 2) {
	log("Reading Steam credentials from command line");
	client.logOn({
		"accountName": process.argv[argsStartIdx],
		"password": process.argv[argsStartIdx + 1]
	});
} else {
	prompt.start();
	prompt.get({
		"properties": {
			"username": {
				"required": true
			},
			"password": {
				"hidden": true,
				"required": true
			}
		}
	}, function(err, result) {
		if(err) {
			log("Error: " + err);
			shutdown(1);
			return;
		}
		
		log("Initializing Steam client...");
		client.logOn({
			"accountName": result.username,
			"password": result.password
		});
	});
}

client.on('loggedOn', function() {
	log("Logged into Steam!");
	checkMinPlaytime();
});

client.on('error', function(e) {
	log("Error: " + e);
});

function checkMinPlaytime() {
	log("Checking app playtime...");

	client.webLogOn();
	client.once('webSession', function(sessionID, cookies) {
		cookies.forEach(function(cookie) {
			g_Jar.setCookie(cookie, 'https://steamcommunity.com');
		});
		
		request("https://steamcommunity.com/my/badges/?p="+g_Page, function(err, response, body) {
			if(err || response.statusCode != 200) {
				log("Couldn't request badge page: " + (err || "HTTP error " + response.statusCode) + ". Retrying in 10 seconds...");
				setTimeout(checkMinPlaytime, 10000);
				return;
			}
			
			var lowHourApps = [];
			
			var $ = Cheerio.load(body);
			$('.badge_row').each(function() {
				var row = $(this);
				var overlay = row.find('.badge_row_overlay');
				if(!overlay) {
					return;
				}
				
				var match = overlay.attr('href').match(/\/gamecards\/(\d+)/);
				if(!match) {
					return;
				}
				
				var appid = parseInt(match[1], 10);

				var name = row.find('.badge_title');
				name.find('.badge_view_details').remove();
				name = name.text().replace(/\n/g, '').replace(/\r/g, '').replace(/\t/g, '').trim();

				// Find out if we have drops left
				var drops = row.find('.progress_info_bold').text().match(/(\d+)/);
				if(!drops) {
					return;
				}
				
				drops = parseInt(drops[1], 10);
				if(isNaN(drops) || drops < 1) {
					return;
				}
				
				// Find out playtime
				var playtime = row.find('.badge_title_stats').html().match(/(\d+\.\d+)/);
				if(!playtime) {
					playtime = 0.0;
				} else {
					playtime = parseFloat(playtime[1], 10);
					if(isNaN(playtime)) {
						playtime = 0.0;
					}
				}
				
				if(playtime < 2.0) {
					// It needs hours!
					
					lowHourApps.push({
						"appid": appid,
						"name": name,
						"playtime": playtime,
					});
				} else {
					g_OwnedApps.push(appid);
				}
			});
			
			if(lowHourApps.length > 0) {
				var minPlaytime = 2.0;
				
				lowHourApps.forEach(function(app) {
					if(app.playtime < minPlaytime) {
						minPlaytime = app.playtime;
					}

					log('App ' + app.appid + ' - ' + app.name + ' - Playtime: ' + app.playtime);
				});
				
				var lowAppsToIdle = lowHourApps.map(function(app) { return app.appid; });

				if(lowAppsToIdle.length < 1) {
					checkCardApps();
				} else {
					g_OwnedApps = g_OwnedApps.concat(lowAppsToIdle);
					client.gamesPlayed(lowAppsToIdle);
					log("Idling " + lowAppsToIdle.length + " app" + (lowAppsToIdle.length == 1 ? '' : 's') + " up to 2 hours.\nYou likely won't receive any card drops in this time.\nThis will take " + (2.0 - minPlaytime) + " hours.");
					setTimeout(function() {
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

client.on('newItems', function(count) {
	if(g_OwnedApps.length == 0 || count == 0) {
		return;
	}

	log("Got notification of new inventory items: " + count + " new item" + (count == 1 ? '' : 's'));
	checkCardApps();
});

function checkCardApps() {
	if(g_CheckTimer) {
		clearTimeout(g_CheckTimer);
	}
	
	log("Checking card drops...");
	
	client.webLogOn();
	client.once('webSession', function(sessionID, cookies) {
		cookies.forEach(function(cookie) {
			g_Jar.setCookie(cookie, 'https://steamcommunity.com');
		});
		
		request("https://steamcommunity.com/my/badges/?p="+g_Page, function(err, response, body) {
			if(err || response.statusCode != 200) {
				log("Couldn't request badge page: " + (err || "HTTP error " + response.statusCode));
				checkCardsInSeconds(30);
				return;
			}
			
			var appsWithDrops = 0;
			var totalDropsLeft = 0;
			var appLaunched = false;
			
			var $ = Cheerio.load(body);
			var infolines = $('.progress_info_bold');
			
			for(var i = 0; i < infolines.length; i++) {
				var match = $(infolines[i]).text().match(/(\d+)/);
				
				var href = $(infolines[i]).closest('.badge_row').find('.badge_title_playgame a').attr('href');
				if(!href) {
					continue;
				}
				
				var urlparts = href.split('/');
				var appid = parseInt(urlparts[urlparts.length - 1], 10);
				
				if(!match || !parseInt(match[1], 10) || g_OwnedApps.indexOf(appid) == -1) {
					continue;
				}
				
				appsWithDrops++;
				totalDropsLeft += parseInt(match[1], 10);
				
				if(!appLaunched) {
					appLaunched = true;
					
					var title = $(infolines[i]).closest('.badge_row').find('.badge_title');
					title.find('.badge_view_details').remove();
					title = title.text().trim();
					
					log("Idling app " + appid + " \"" + title + "\" - " + match[1] + " drop" + (match[1] == 1 ? '' : 's') + " remaining");
					client.gamesPlayed(parseInt(appid, 10));
				}
			}
			
			log(totalDropsLeft + " card drop" + (totalDropsLeft == 1 ? '' : 's') + " remaining across " + appsWithDrops + " app" + (appsWithDrops == 1 ? '' : 's') + " (Page " + g_Page + ")");
			if(totalDropsLeft == 0) {
				if ($('.badge_row').length > 0){
					log("No drops remaining on page "+g_Page);
					g_Page++;
					log("Checking page "+g_Page);
					checkMinPlaytime();
				} else {
					log("All card drops recieved!");
					log("Shutting Down.")
					shutdown(0);
				}
			} else {
				checkCardsInSeconds(1200); // 20 minutes to be safe, we should automatically check when Steam notifies us that we got a new item anyway
			}
		});
	});
}

function checkCardsInSeconds(seconds) {
	g_CheckTimer = setTimeout(checkCardApps, (1000 * seconds));
}

process.on('SIGINT', function() {
	log("Logging off and shutting down");
	shutdown(0);
});

function shutdown(code) {
	client.logOff();
	client.once('disconnected', function() {
		process.exit(code);
	});

	setTimeout(function() {
		process.exit(code);
	}, 500);
}
