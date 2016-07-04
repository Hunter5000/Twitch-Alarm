/*jshint bitwise: true, curly: true, eqeqeq: true, forin: true, freeze: true, nocomma: true, noarg: true, nonbsp: true, nonew: true, singleGroups: true, plusplus: true, undef: true, latedef: true, moz: true*/
/* globals require, OS, exports, console */

//Define the APIs of the Add-on SDK that we're going to need

var Request = require("sdk/request").Request;
var _ = require("sdk/l10n").get;
var notifications = require("sdk/notifications");
var pageWorkers = require("sdk/page-worker");
var panels = require("sdk/panel");
var self = require("sdk/self");
var sp = require("sdk/simple-prefs");
var ss = require("sdk/simple-storage");
var system = require("sdk/system");
var tabs = require("sdk/tabs");
var utils = require('sdk/window/utils');
var { Cc, Ci, Cu } = require("chrome");
var { ToggleButton } = require("sdk/ui/button/toggle");
var { clearInterval, clearTimeout, setInterval, setTimeout } = require("sdk/timers");

Cu.import("resource://gre/modules/osfile.jsm");

//Define two scripts we're going to need

var OAuth2 = require("./oauth2");
var alarmHandler = pageWorkers.Page({
    contentScriptFile: self.data.url("alarm.js"),
    contentURL: self.data.url("twitchFox.html")
});

//Define what the default settings for the add-on are

var defaultSettings = {
	alarmDisableIconFlashing: false,
	alarmInterval: 1,
	alarmLength: 10,
	alarmLimit: false,
	alarmNotifs: true,
	alarmOnOfflineChannel: false,
	alarmOnOnlineChannel: true,
	alarmOnOnlineGame: false,
	alarmOnStatusChange: false,
	alarmOnlineGames: [],
	alarmPath: "",
	alarmRestrict: false,
	alarmRestrictFrom: "22:00:00",
	alarmRestrictTo: "06:00:00",
	alarmSound: true,
	alarmStreamIds: [],
	alarmUpdate: 60,
	alarmVolume: 50,
	followedAuthInfo: {},
	followedChannels: [],
	followedGames: [],
	followedMutedChannels: [],
	followedMutedGames: [],
	interDarkMode: false,
	interFollowedMode: false,
	interHideAvatar: false,
	interHideOffline: false,
	interHidePreview: false,
	interLivestreamerPath: "",
	interLivestreamerQuality: "best",
	interLivestreamerReady: false,
	interMode: "games",
	interOpenChat: false,
	interOpenLive: false,
	interOpenPage: false,
	interOpenPopout: false,
	interOpenPopup: true,
	interSearchLim: 20,
	interSortMethod: "viewers",
};

function cleanSettings(setDefault) {
    var key;
    //If a setting is undefined or of the wrong type, define it as its default
    for (key in defaultSettings) {
        if (defaultSettings.hasOwnProperty(key) && (!ss.storage.hasOwnProperty(key) || typeof ss.storage[key] !== typeof defaultSettings[key])) {
            ss.storage[key] = defaultSettings[key];
        } else if (setDefault) {
            ss.storage[key] = defaultSettings[key];
        }
    }

    //If there is a setting that does not have a default, delete it
    for (key in ss.storage) {
        if (ss.storage.hasOwnProperty(key) && !defaultSettings.hasOwnProperty(key)) {
            delete ss.storage[key];
        }
    }
	
	//Check to make sure the user has the correct object types
	
	if (ss.storage.followedChannels[0] && !ss.storage.followedChannels[0].hasOwnProperty("type")) {
		ss.storage.followedChannels = defaultSettings.followedChannels;
	}
	
	if (ss.storage.followedGames[0] && !ss.storage.followedGames[0].hasOwnProperty("type")) {
		ss.storage.followedGames = defaultSettings.followedGames;
	}
}

//Arrays

var onlineInfo = [];
var gameInfo = [];
var videoInfo = [];
var topStreamInfo = [];
var topGameInfo = [];
var topVideoInfo = [];
var searchHistory = [];

//Bools

var settingsMode = false;
var autoLogout = false;

//Intervals

var updateInterval;

//Objects

var button;
var panel;
var alarm;
var livestreamerHandler;

//Functions

var updateBadge;
var panelUpdate;
var followedChannelUpdate;
var followedGameUpdate;
var followedVideoUpdate;
var update;

var twitchOauth = OAuth2.addAdapter({
    id: 'twitch',
    codeflow: {
        method: "POST",
        url: "https://api.twitch.tv/kraken/oauth2/token"
    },
    opts: {
        api: "https://api.twitch.tv/kraken/oauth2/authorize",
        response_type: 'token',
        client_id: 'dzawctbciav48ou6hyv0sxbgflvfdpp',
        client_secret: 'b1smws17iv8ob4wpbi4671mf6ceus3r',
        scope: 'user_follows_edit user_read',
        redirect_uri: 'https://hunter5000.github.io/twitchfox.html'
    }
});

function getPosByProp(arr, prop, val) {
    var i;
    for (i = 0; i < arr.length; i += 1) {
        if (arr[i][prop] === val) {
            return i;
        }
    }
    return -1;
}

function sortByProp(arr, prop, reversed) {
    var output = arr.sort(function (a, b) {
        a = typeof a[prop] === "string" ? a[prop].toLowerCase() : a[prop];
        b = typeof b[prop] === "string" ? b[prop].toLowerCase() : b[prop];
		a = !a && a !== 0 ? -1 : a;
		b = !b && b !== 0 ? -1 : b;
        if (a < b) {return -1;}
        if (a > b) {return 1;} 
        return 0;
    });
    return reversed ? output.reverse() : output;
}

function genArrayFromProp(arr, prop) {
    var newArr = [], i;
    for (i = 0; i < arr.length; i += 1) {
        newArr.push(arr[i][prop]);
    }
    return newArr;
}

function parseTime(time) {
    return Date.UTC(time.slice(0, 4), Number(time.slice(5, 7)) - 1, time.slice(8, 10), time.slice(11, 13), time.slice(14, 16), time.slice(17, 19));
}

function onPanelOpen() {
	button.state('window', {
		checked: true
	});
	panelUpdate();
	if (alarm.on) {
		panel.port.emit("forcePrompt", alarm.cause);
		alarm.end();
	}
}

function onPanelClose() {
	//Close the panel
    button.state('window', {
        checked: false
    });
    updateBadge();
}

button = ToggleButton({
    id: "my-button",
    label: _("clickOpen"),
    icon: "./icon.png",
    badge: null,
    badgeColor: "#6441A5",
    onChange: function(state) {
		if (state.checked) {
			panel.show();
		}	
	},
});

sp.on("settingsButton", function () {
    settingsMode = true;
    panel.show();
	panel.port.emit("toggleSettingsMode", settingsMode);
});

alarm = {
    cause: null,
    counter: 0,
    on: false,
	badgeInterval: null,
	countInterval: null,
    restricted: function () {
        if (!ss.storage.alarmRestrict) {return false;}
        var restrictFrom = Number(ss.storage.alarmRestrictFrom.replace(/\D/g, ''));
        var restrictTo = Number(ss.storage.alarmRestrictTo.replace(/\D/g, ''));
        var newDate = new Date();
        var newHours = String(newDate.getHours());
        var newMins = String(newDate.getMinutes());
        var newSecs = String(newDate.getSeconds());
        if (Number(newHours) < 10) {
            newHours = "0" + newHours;
        }
        if (Number(newMins) < 10) {
            newMins = "0" + newMins;
        }
        if (Number(newSecs) < 10) {
            newSecs = "0" + newSecs;
        }
        var curTime = Number(newHours + newMins + newSecs);
        return restrictTo <= restrictFrom ? curTime >= restrictFrom || curTime <= restrictTo : curTime >= restrictFrom && curTime <= restrictTo;
    },
    genNotif: function(obj, type) {
        var title = "";
        var text = "";
        switch (type) {
            case "onOnlineChannel":
                title = obj.display_name + " " + _("hasCome") + " " + (obj.game ? obj.game : "");
                text = '"' + obj.status + '"' + "\n\n" + _("clickHere");
                break;
            case "onStatusChange":
                title = obj.display_name + " " + _("hasChanged");
                text = '"' + obj.status + '"' + "\n\n" + _("clickHere");
                break;
            case "onOfflineChannel":
                title = obj.display_name + " " + _("hasOffline");
                break;
            case "onOnlineGame":
                title = obj.name + " " + _("gameOnline");
                text = _("clickHere");
                break;
        }
		if (ss.storage.alarmPanel) {
			var alarmPanel = panels.Panel({
				contentURL: self.data.url("alarmPanel.html")
			});
			alarmPanel.show();
		}
		else {
			notifications.notify({
				title: title,
				text: text,
				iconURL: obj.logo || obj.type === "game" && "http://static-cdn.jtvnw.net/ttv-boxart/" + obj.name + "-56x78.jpg" || "http://static-cdn.jtvnw.net/jtv_user_pictures/xarth/404_user_150x150.png",
				onClick: function () {
					setTimeout(function() {
						utils.getMostRecentBrowserWindow().focus();
						ss.storage.interFollowedMode = true;
						ss.storage.interMode = type !== "onOnlineGame" ? "channels" : "games";
						panel.port.emit("settingsUpdate", ss.storage);
						if (searchHistory.length) {
							searchHistory = [];
							panel.port.emit("endSearch", searchHistory);
						}
						panel.show();
					}, 200);
				}
			});
		}
    },
    set: function (obj, type) {
		if (panel.isShowing) {
			panel.port.emit("forcePrompt", obj);
			if (ss.storage.alarmSound && !this.restricted()) {
				alarmHandler.port.emit("play");
			}
			return;
		}
        if (this.on) {
            return;
        }
        this.on = true;
        this.cause = obj;
        if (ss.storage.alarmNotifs) {
            this.genNotif(obj, type);
        }
		var flashBadge = function () {
			button.badgeColor = "#FF0000";
			var badgeTimeout;
			badgeTimeout = setTimeout(function () {
				button.badgeColor = "#6641A5";
				clearTimeout(badgeTimeout);
			}, 250);    
    	};
		if (!ss.storage.alarmDisableIconFlashing) {
			this.badgeInterval = setInterval(flashBadge, ss.storage.alarmInterval * 1000);
			flashBadge();
		}
		var root = this;
        if (ss.storage.alarmLimit) {
			var countAlarm = function () {
				root.counter += 1;
				if (root.counter > ss.storage.alarmLength) {
					alarm.end();
					root.counter = 0;
				}
			};
            this.countInterval = setInterval(countAlarm, 1000);
			countAlarm();
        }
        if (ss.storage.alarmSound && !this.restricted()) {
            alarmHandler.port.emit("set");
        }
    },
    end: function () {
        this.on = false;
        alarmHandler.port.emit("end");
        clearInterval(this.countInterval);
        clearInterval(this.badgeInterval);
        button.badgeColor = "#6641A5";
        this.cause = null;
    }
};

panelUpdate = function () {
    //Give the panel Twitch info, such as online channels, searched games, etc.

	updateBadge();
	
    if (!panel.isShowing) {return; }

    //We will give the panel an array that contains the information it needs. It's only going to need one array at a time.
    
    var info, i, followList, key;
    
    if (searchHistory.length) {
        //We need to give the panel information about the current search
        info = searchHistory[searchHistory.length - 1].result;
    } else {
        //We need to give the panel information based on its current mode
        switch (ss.storage.interMode) {
            case "channels":
                if (ss.storage.interFollowedMode) {
                    info = [];
                    followList = ss.storage.followedAuthInfo.followedChannels || ss.storage.followedChannels;
                    for (i = 0; i < followList.length; i += 1) {
                        key = getPosByProp(onlineInfo, "name", followList[i].name);
                        if (key > -1) {
                            info.push(onlineInfo[key]);
                        } else {
                            info.push(followList[i]);
                        }
                    }
                } else {
                    info = topStreamInfo;
                }
                switch (ss.storage.interSortMethod) {
                    case "viewers":
                        info = sortByProp(info, "viewers", true);
                        break;
                    case "recent":
                        info = sortByProp(info, "time", true);
                        break;
                    case "alphabetical":
                        info = sortByProp(info, "display_name");
                        break;
                }
                break;
            case "games":
                if (ss.storage.interFollowedMode) {
                    info = [];
                    followList = ss.storage.followedAuthInfo.followedGames || ss.storage.followedGames;
                    for (i = 0; i < followList.length; i += 1) {
                        key = getPosByProp(gameInfo, "name", followList[i].name);
                        if (key > -1) {
                            info.push(gameInfo[key]);
                        } else {
                            info.push(followList[i]);
                        }
                    }
                } else {
                    info = topGameInfo;
                }
                switch (ss.storage.interSortMethod) {
                    case "viewers":
                        info = sortByProp(info, "viewers", true);
                        break;
                    case "recent":
                        info = sortByProp(info, "channels", true);
                        break;
                    case "alphabetical":
                        info = sortByProp(info, "name");
                        break;
                }
                break;
            case "videos":
                if (ss.storage.interFollowedMode) {
                    info = videoInfo;
                } else {
                    info = topVideoInfo;
                }
                switch (ss.storage.interSortMethod) {
                    case "viewers":
                        info = sortByProp(info, "views", true);
                        break;
                    case "recent":
                        info = sortByProp(info, "time", true);
                        break;
                    case "alphabetical":
                        info = sortByProp(info, "title");
                        break;
                }
                break;
        }
    }
    panel.port.emit("infoUpdate", {info: info, onlineChanLen: onlineInfo.length, onlineGameLen: gameInfo.length, searchHistory: searchHistory});
};

livestreamerHandler = {
    getPath: function () {
        var path,
            pathError = false,
            file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
            // User defined
        if (ss.storage.interLivestreamerPath) {
            path = ss.storage.interLivestreamerPath.replace("\\", "\\\\");
        } else if (system.platform === "linux") {
            path = "/usr/bin/livestreamer";
        } else if (system.platform === "winnt") {
            path = "C:\\Program Files (x86)\\Livestreamer\\livestreamer.exe";
        } else if (system.platform === "mac") {
            path = "/Applications/livestreamer.app";
        }
        // Test file
        try {
            file.initWithPath(path);
        } catch (e) {
            pathError = true;
        } finally {
            return pathError ? null : file.exists() ? path : null;
        }
    },
    checkIfReady: function() {
		ss.storage.interLivestreamerReady = this.getPath() ? true : false;
		panel.port.emit("settingsUpdate", ss.storage);
    },
    run: function (args) {
        //args = [url, quality]
        var path,
            file,
            process;
        path = this.getPath();
        if (path) {
            // Build file
            file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
            file.initWithPath(path);
                // New child process
            process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
            process.init(file);
            process.run(false, args, args.length);
        }
        panel.port.emit("openLive");
    },
    getQualities: function(stream, callback) {
        var url = "http://www.twitch.tv/" + stream;
        var i,
            path,
            process,
            livestreamer,
            jsonData = '',
            ls,
            quality,
            qualityPattern = ['best', 'source', 'live', '2160p', '1440p', '1080p+', '1080p', 'ultra', 'high', '720p+', '720p', 'medium', 'mid', '480p+', '480p', 'low', '360p+', '360p', '240p', '144p', 'mobile', 'worst', 'audio'],
            results = [];
        path = this.getPath();
        if (path === null) {
            return;
        }
        // Create child instance
        process = require("sdk/system/child_process");
        livestreamer = process.spawn(path, ["--json", url]);
        livestreamer.stdout.on('data', function (data) {
            jsonData += data;
        });
        livestreamer.on("exit", function () {
            ls = JSON.parse(jsonData);
            if (!ls.hasOwnProperty('error')) {
                quality = Object.keys(ls.streams); 
                // Sort
                for (i = 0; i < qualityPattern.length; i += 1) {
                    if (quality.indexOf(qualityPattern[i]) > -1 ) {
                        results.push(qualityPattern[i]);
                    }
                }
                // Add left over qualiies
                for (i = 0; i < quality.length; i += 1) {
                    if (results.indexOf(quality[i]) < 0) {
                        results.push(quality[i]);
                    }
                }
            }
			callback(results);
        });
    }
};

function twitchAPI(obj, callback) {
    var url = obj.url;
    var act = "get";
    if (!url) {
		var type = obj.type;
		var target = obj.target || "";
		var offset = obj.offset || 0;
		var limit = obj.limit || ss.storage.interSearchLim;
        url = type === "followGame" || type === "unfollowGame" || type === "getFollowedGames" ? "https://api.twitch.tv/api/users/" : "https://api.twitch.tv/kraken/";
        target = Array.isArray(target) ? target.join(",") : target;
        switch (obj.type) {
            case "checkStreams":
                url += "streams?limit=100&offset=" + offset + "&channel=" + target;
                break;
            case "followChannel":
                url += "users/" + ss.storage.followedAuthInfo.name + "/follows/channels/" + target;
                act = "put";
                break;
            case "followGame":
                url += ss.storage.followedAuthInfo.name + "/follows/games/" + target;
                act = "put";
                break;
            case "gameSummary":
                url += "streams/summary?game=" + target;
                break;
            case "getBroadcasts":
                url += "channels/" + target + "/videos?limit=" + limit + "&broadcasts=true&offset=" + offset;
                break;
            case "getChannel":
                url += "channels/" + target;
                break;
            case "getFollowedChannels":
                url += "users/" + target + "/follows/channels?limit=100&sortby=created_at&direction=DESC&offset=" + offset;
                break;
            case "getFollowedGames":
                url += target + "/follows/games?limit=100&sortby=created_at&direction=DESC&offset=" + offset;
                break;
            case "getFollowedStreams":
                url += "streams/followed?limit=100&stream_type=all&offset=" + offset;
                break;
            case "getFollowedVideos":
                url += "videos/followed?limit=" + limit + "&offset=" + offset;
                break;
            case "getGameStreams":
                url += "streams?limit=" + limit + "&offset=" + offset + "&game=" + target;
                break;
            case "getGameVideos":
                url += "videos/top?limit=" + limit + "&offset=" + offset + "&game=" + target;
                break;
            case "getHighlights":
                url += "channels/" + target + "/videos?limit=" + limit + "&offset=" + offset;
                break;
            case "getTopGames":
                url += "games/top?limit=" + limit + "&offset=" + offset;
                break;
            case "getTopStreams":
                url += "streams?limit=" + limit + "&offset=" + offset;
                break;
            case "getTopVideos":
                url += "videos/top?limit=" + limit + "&offset=" + offset;
                break;
            case "getUser":
                url += "user";
                break;
            case "searchChannels":
                url += "search/channels?limit=" + limit + "&offset=" + offset + "&q=" + target;
                break;
            case "searchGames":
                url += "search/games?type=suggest&q=" + target;
                break;
            case "searchLiveGames":
                url += "search/games?type=suggest&live=true&q=" + target;
                break;
            case "searchStreams":
                url += "search/streams?limit=" + limit + "&offset=" + offset + "&q=" + target;
                break;
            case "unfollowChannel":
                url += "users/" + ss.storage.followedAuthInfo.name + "/follows/channels/" + target;
                act = "delete";
                break;
            case "unfollowGame":
                url += ss.storage.followedAuthInfo.name + "/follows/games/" + target;
                act = "delete";
                break;
        }
    }
    Request({
        url: url,
        onComplete: callback,
        headers: {
            'Accept': "application/vnd.twitchtv.v3+json",
            'Client-ID': "dzawctbciav48ou6hyv0sxbgflvfdpp",
            'Authorization': 'OAuth ' + ss.storage.followedAuthInfo.token
        }
    })[act]();
}

function importFollowedChannels(callback, target, offset = 0, imported = []) {
    twitchAPI({type: "getFollowedChannels", target: target, offset: offset}, function (response) {
        if (response.json) {
            var follows = response.json.follows;
            if (follows) {
                var i;
                for (i = 0; i < follows.length; i += 1) {
                    var item = follows[i];
                    var channel = {
                        name: item.channel.name,
                        display_name: item.channel.display_name,
						type: "channel"
                    };
                    imported.push(channel);
                }
                // Get more if they exist
                if (response.json._total > offset + 100) {
                    importFollowedChannels(callback, target, offset + 100, imported);
                } else {
                    callback(imported);
                }
            } else {
				callback(imported);
			}
        } else {
			callback(imported);
		}
    });
}

function importFollowedGames(callback, target, offset = 0, imported = []) {
    twitchAPI({type: "getFollowedGames", target: target, offset: offset}, function (response) {
        if (response.json) {
            var follows = response.json.follows;
            if (follows) {
                var i;
                for (i = 0; i < follows.length; i += 1) {
                    var item = follows[i];
                    var game = {
						name: item.name,
						type: "game"
					};
                    imported.push(game);
                }
                // Get more if they exist
                if (response.json._total > offset + 100) {
                    importFollowedChannels(callback, target, offset + 100, imported);
                } else {
                    callback(imported);
                }
            } else {
				callback(imported);
			}
        } else {
			callback(imported);
		}
    });
}

function syncFollowedChannels() {
    if (!ss.storage.followedAuthInfo.token) {return; }
    
	importFollowedChannels(function(channels) {
		ss.storage.followedAuthInfo.followedChannels = channels;
		panel.port.emit("settingsUpdate", ss.storage);
		followedChannelUpdate();
	}, ss.storage.followedAuthInfo.name);
}

function syncFollowedGames() {
    if (!ss.storage.followedAuthInfo.token) {return; }
    
	importFollowedGames(function(games) {
		ss.storage.followedAuthInfo.followedGames = games;
		panel.port.emit("settingsUpdate", ss.storage);
		followedGameUpdate();
	}, ss.storage.followedAuthInfo.name);
}

function logout() {
    //Logging out is much easier than logging in
    if (ss.storage.followedAuthInfo.token) {
        delete ss.storage.followedAuthInfo.display_name;
        delete ss.storage.followedAuthInfo.followedChannels;
        delete ss.storage.followedAuthInfo.followedGames;
        delete ss.storage.followedAuthInfo.name;
        delete ss.storage.followedAuthInfo.token;
		panel.port.emit("settingsUpdate", ss.storage);
        onlineInfo = [];
        update();
    }
	panel.port.emit("logout");
}

function authSync() {
    twitchAPI({type: "getUser"}, function (response) {
		if (response.json) {
			if (response.json.error === "Unauthorized") {
				if (autoLogout) {
					logout();
				}
				return;
			}
			ss.storage.followedAuthInfo.name = response.json.name;
			ss.storage.followedAuthInfo.display_name = response.json.display_name;
			panel.port.emit("settingsUpdate", ss.storage);
			syncFollowedChannels();
			syncFollowedGames();
		}
    });
}

function login() {
    //Log in to Twitch by obtaining an authorization token
    panel.hide();
    twitchOauth.authorize(function () {
        //We have obtained a token, or at least a response
        var response = twitchOauth.getAccessToken();
        if (response) {
            ss.storage.followedAuthInfo.token = response;
            authSync();
        }
    });
	panel.port.emit("login");
}

function followChannel(target) {
    var followList = ss.storage.followedAuthInfo.followedChannels || ss.storage.followedChannels;
    var key = getPosByProp(followList, "name", target);
    if (key < 0) {
        twitchAPI({type: "getChannel", target: target}, function (response) {
            if (response.json ? !response.json.error : false) {
                var channel = response.json;
                if (ss.storage.followedAuthInfo.token) {
                    twitchAPI({type: "followChannel", target: target}, function (thisResponse) {
                        if (thisResponse.json && thisResponse.json.error === "Unauthorized") {
                            if (autoLogout) {
								logout();
							}
                            return;
                        }
                        syncFollowedChannels();
                    });
                } else {
                    ss.storage.followedChannels.push({name: channel.name, display_name: channel.display_name, type: "channel"});
                    panel.port.emit("settingsUpdate", ss.storage);
                    followedChannelUpdate();
                }
            } else {
                panel.port.emit("settingsUpdate", ss.storage);
            }
        });
    } else {
		panel.port.emit("settingsUpdate", ss.storage);
	}
}

function unfollowChannel(target) {
    var followList = ss.storage.followedAuthInfo.followedChannels || ss.storage.followedChannels;
    var key = getPosByProp(followList, "name", target);
    if (key > -1) {
        if (ss.storage.followedAuthInfo.token) {
            twitchAPI({type: "unfollowChannel", target: target}, function (thisResponse) {
                if (thisResponse.json && thisResponse.json.error === "Unauthorized") {
					if (autoLogout) {
						logout();
					}
                    return;
                }
                syncFollowedChannels();
            });
        } else {
            ss.storage.followedChannels.splice(key, 1);
            panel.port.emit("settingsUpdate", ss.storage);
            followedChannelUpdate();
        }
    } else {
		panel.port.emit("settingsUpdate", ss.storage);
	}
}

function followGame(target) {
    var followList = ss.storage.followedAuthInfo.followedGames || ss.storage.followedGames;
    var key = getPosByProp(followList, "name", target);
    if (key < 0) {
        if (ss.storage.followedAuthInfo.token) {
            twitchAPI({type: "followGame", target: target}, function (thisResponse) {
                if (thisResponse.json && thisResponse.json.error === "Unauthorized") {
					if (autoLogout) {
						logout();
					}
                    return;
                }
                syncFollowedGames();
            });
        } else {
            ss.storage.followedGames.push({name: target, type: "game"});
            panel.port.emit("settingsUpdate", ss.storage);
            followedGameUpdate();
        }
    } else {
		panel.port.emit("settingsUpdate", ss.storage);
	}
}

function unfollowGame(target) {
    var followList = ss.storage.followedAuthInfo.followedGames || ss.storage.followedGames;
    var key = getPosByProp(followList, "name", target);
    if (key > -1) {
        if (ss.storage.followedAuthInfo.token) {
            twitchAPI({type: "unfollowGame", target: target}, function (thisResponse) {
                if (thisResponse.json && thisResponse.json.error === "Unauthorized") {
					if (autoLogout) {
						logout();
					}
                    return;
                }
                syncFollowedGames();
            });
        } else {
            ss.storage.followedGames.splice(key, 1);
            panel.port.emit("settingsUpdate", ss.storage);
            followedGameUpdate();
        }
    } else {
		panel.port.emit("settingsUpdate", ss.storage);
	}
}

function checkFollowedChannel(channel) {
    twitchAPI({type: "getChannel", target: channel.name}, function (response) {
        if (response.json ? response.json.error === "Not found": false) {
            var key = getPosByProp(ss.storage.followedChannels, "name", channel.name);
            ss.storage.followedChannels.splice(key, 1);
        }
    });
}

function checkFollowedChannels() {
    for (var i = 0; i < ss.storage.followedChannels.length; i += 1) {
        checkFollowedChannel(ss.storage.followedChannels[i]);
    }
}

function Channel(stream, min) {
    var channel = stream.channel || stream;
    this.display_name = channel.display_name;
    this.game = channel.game;
    this.language = channel.broadcaster_language || channel.language;
    this.logo = channel.logo || "http://static-cdn.jtvnw.net/jtv_user_pictures/xarth/404_user_150x150.png";
    this.name = channel.name;
    this.online = stream.viewers !== undefined;
    this.status = channel.status;
    this.type = "channel";
    if (this.online) {
        this.time = parseTime(stream.created_at);
        this.viewers = stream.viewers;
    }
    if (!min) {
        this.followers = channel.followers;
        this.views = channel.views;
    }
}

function Game(top) {
    var game = top.game || top;
    if (top.channels !== undefined) {
        this.channels = top.channels;
        this.viewers = top.viewers;
    }
    this.name = game.name || decodeURIComponent(top._links.self.substr(50)).split("+").join(" ");
    this.type = "game";
    this.online = this.viewers || this.channels ? true : false;
}

function Video(video) {
    this.description = video.description;
    this.display_name = video.channel.display_name;
    this.game = video.game;
    this.highlight = video.broadcast_type === "highlight";
    this._id = video._id;
    this.length = video.length * 1000;
    this.link = video.url.slice(21);
    this.name = video.channel.name;
    this.preview = video.preview;
    this.time = parseTime(video.recorded_at);
    this.title = video.title;
    this.type = "video";
    this.views = video.views;
}

function Search(type, target, userInput) {
    this.fromUserInput = userInput;
    this.next = "";
    this.result = [];
    this.scrollY = 0;
	this.prompt = null;
    this.target = target;
    this.total = null;
    this.type = type;
    switch (type) {
        case "channels":
            this.resultType = "generalChannels";
            break; 
        case "streams":
        case "getGameStreams":
            this.resultType = "channels";
            break;
        case "games":
            this.resultType = "games";
            break;
        case "getHighlights":
        case "getBroadcasts":
		case "getGameVideos":
            this.resultType = "videos";
            break;
    }
}

function searchTwitch(search, callback) {
    //This function will take a search for an input, find that search's results, and then trigger a callback with the updated search
    var APIparams;
    if (search.next) {
        APIparams = {url: search.next};
    }
    switch (search.type) {
        case "channels":
            APIparams = APIparams || {type: "searchChannels", target: search.target};
            twitchAPI(APIparams, function (response) {
                var i;
                if (response.json) {
                    var channels = response.json.channels;
                    search.total = response.json._total;
                    search.next = response.json._links && response.json._links.next;
                    for (i = 0; i < channels.length; i += 1) {
                        var channel = new Channel(channels[i]);
                        var key = getPosByProp(search.result, "name", channel.name);
                        if (key < 0) {
                            search.result.push(channel);
                        } else {
                            search.result[key] = channel;
                        }
                    }
                    twitchAPI({type: "checkStreams", target: genArrayFromProp(search.result, "name")}, function (response) {
                        if (response.json) {
                            var streams = response.json.streams;
                            for (i = 0; i < streams.length; i += 1) {
                                var stream = new Channel(streams[i]);
                                var key = getPosByProp(search.result, "name", stream.name);
                                if (key > -1) {
                                    search.result[key] = stream;
                                }
                            }
                            callback(search);
                        } else {
                            callback(search);
                        }
                    });
                } else {
                    callback(search);
                }
            });
            break;
        case "games":
            APIparams = APIparams || {type: "searchGames", target: search.target};
            twitchAPI(APIparams, function (response) {
                var i;
                if (response.json) {
                    var games = response.json.games;
                    search.next = response.json._links && response.json._links.next;
                    for (i = 0; i < games.length; i += 1) {
                        var game = new Game(games[i]);
                        var key = getPosByProp(search.result, "name", game.name);
                        if (key < 0) {
                            search.result.push(game);
                        } else {
                            search.result[key] = game;
                        }
                    }
                    search.total = search.result.length;
                    twitchAPI({type: "searchLiveGames", target: search.target}, function (response) {
                        if (response.json) {
                            var games = response.json.games;
                            for (i = 0; i < games.length; i += 1) {
                                var liveGame = new Game(games[i]);
                                liveGame.online = true;
                                var key = getPosByProp(search.result, "name", liveGame.name);
                                if (key > -1) {
                                    search.result[key] = liveGame;
                                }
                            }
                            search.total = search.result.length;
                            callback(search);
                        } else {
                            callback(search);
                        }
                    });
                } else {
                    callback(search);
                }
            }, search.target);
            break;
        case "streams":
            APIparams = APIparams || {type: "searchStreams", target: search.target};
            twitchAPI(APIparams, function (response) {
                var i;
                if (response.json) {
                    var streams = response.json.streams;
                    search.total = response.json._total;
                    search.next = response.json._links && response.json._links.next;
                    for (i = 0; i < streams.length; i += 1) {
                        var stream = new Channel(streams[i]);
                        var key = getPosByProp(search.result, "name", stream.name);
                        if (key < 0) {
                            search.result.push(stream);
                        } else {
                            search.result[key] = stream;
                        }
                    }
                    callback(search);
                } else {
                    callback(search);
                }
            });
            break;
        case "getGameStreams":
            APIparams = APIparams || {type: "getGameStreams", target: search.target};
            twitchAPI(APIparams, function (response) {
                var i;
                if (response.json) {
                    var streams = response.json.streams;
                    search.total = response.json._total;
                    search.next = response.json._links && response.json._links.next;
                    for (i = 0; i < streams.length; i += 1) {
                        var stream = new Channel(streams[i]);
                        var key = getPosByProp(search.result, "name", stream.name);
                        if (key < 0) {
                            search.result.push(stream);
                        } else {
                            search.result[key] = stream;
                        }
                    }
                    callback(search);
                } else {
                    callback(search);
                }
            });
            break;
        case "getHighlights":
            APIparams = APIparams || {type: "getHighlights", target: search.target};
            twitchAPI(APIparams, function (response) {
                var i;
                if (response.json) {
                    var videos = response.json.videos;
                    search.total = response.json._total;
                    search.next = response.json._links && response.json._links.next;
                    for (i = 0; i < videos.length; i += 1) {
                        var video = new Video(videos[i]);
                        var key = getPosByProp(search.result, "_id", video._id);
                        if (key < 0) {
                            search.result.push(video);
                        } else {
                            search.result[key] = video;
                        }
                    }
                    callback(search);
                } else {
                    callback(search);
                }
            });
            break;
        case "getBroadcasts":
            APIparams = APIparams || {type: "getBroadcasts", target: search.target};
            twitchAPI(APIparams, function (response) {
                var i;
                if (response.json) {
                    var videos = response.json.videos;
                    search.total = response.json._total;
                    search.next = response.json._links && response.json._links.next;
                    for (i = 0; i < videos.length; i += 1) {
                        var video = new Video(videos[i]);
                        var key = getPosByProp(search.result, "_id", video._id);
                        if (key < 0) {
                            search.result.push(video);
                        } else {
                            search.result[key] = video;
                        }
                    }
                    callback(search);
                } else {
                    callback(search);
                }
            }, search.target, search.result.length);
            break;
        case "getGameVideos":
            APIparams = APIparams || {type: "getGameVideos", target: search.target};
            twitchAPI(APIparams, function (response) {
                var i;
                if (response.json) {
                    var videos = response.json.videos;
					search.total = response.json._total;
                    search.next = response.json._links && response.json._links.next;
                    for (i = 0; i < videos.length; i += 1) {
                        var video = new Video(videos[i]);
                        var key = getPosByProp(search.result, "_id", video._id);
                        if (key < 0) {
                            search.result.push(video);
                        } else {
                            search.result[key] = video;
                        }
                    }
                    callback(search);
                } else {
                    callback(search);
                }
            });
            break;
    }
}

updateBadge = function () {
	button.badge = onlineInfo.length || null;
	var text;
	if (panel.isShowing) {
		text = _("clickClose");
	} else {
		text = _("clickOpen");
		var sortedInfo = [];
		var i;
		if (onlineInfo.length) {
			switch (ss.storage.interSortMethod) {
				case "viewers":
					sortedInfo = sortByProp(onlineInfo, "viewers", true);
					break;
				case "recent":
					sortedInfo = sortByProp(onlineInfo, "time", true);
					break;
				case "alphabetical":
					sortedInfo = sortByProp(onlineInfo, "display_name");
					break;
			}
			text += "\n\n";
			for (i = 0; i < sortedInfo.length; i += 1) {
				text += sortedInfo[i].display_name;
				if (sortedInfo[i].game) {
					text += " | " + sortedInfo[i].game;
				}
				text += i+1 < sortedInfo.length ? "\n" : "";
			}
		}
		if (gameInfo.length && ss.storage.alarmOnOnlineGame) {
			switch (ss.storage.interSortMethod) {
				case "viewers":
					sortedInfo = sortByProp(gameInfo, "viewers", true);
					break;
				case "recent":
					sortedInfo = sortByProp(gameInfo, "channels", true);
					break;
				case "alphabetical":
					sortedInfo = sortByProp(gameInfo, "name");
					break;
			}
			text += "\n\n";
			for (i = 0; i < sortedInfo.length; i += 1) {
				text += sortedInfo[i].name;
				text += i+1 < sortedInfo.length ? "\n" : "";
			}
		}
	}
    button.label = text;
};

function handleStreamResponse(response, tempInfo, offset, curOnline) {
    var i;
    if (response.json) {
        var streams = response.json.streams;
        if (streams) {
            for (i = 0; i < streams.length; i += 1) {
                //This is an online channel
                var stream = streams[i];
                var channel = new Channel(stream, true);
                curOnline.push(channel.name);
                var _id = stream._id;
                var key = getPosByProp(onlineInfo, "name", channel.name);
                if (key > -1) {
                    //A followed channel that was online before is still online
                    if (ss.storage.alarmStreamIds.indexOf(_id) < 0) {
                        ss.storage.alarmStreamIds.push(_id);
                    }
                    if (channel.status !== onlineInfo[key].status) {
                        if (ss.storage.alarmOnStatusChange && ss.storage.followedMutedChannels.indexOf(channel.name) < 0) {
                            alarm.set(channel, "onStatusChange");
                        }
                    }
                    onlineInfo[key] = channel;
                } else { 
                    //A followed channel that was offline before is now online
                    onlineInfo.push(channel);
                    if (ss.storage.alarmStreamIds.indexOf(_id) < 0) {
                        if (!alarm.on && ss.storage.alarmOnOnlineChannel && ss.storage.followedMutedChannels.indexOf(channel.name) < 0) {
                            alarm.set(channel, "onOnlineChannel");
                        }
                        ss.storage.alarmStreamIds.push(_id);
                    }
                }
            }
        }
        if (response.json._total > offset + 100) {
            //There are more followed channels that must be checked
            followedChannelUpdate(tempInfo, offset + 100, curOnline);
        } else {
            //We have fully checked every followed channel in this update cycle
            for (i = 0; i < tempInfo.length; i += 1) {
                if (curOnline.indexOf(tempInfo[i].name) < 0) {
                    //A followed channel that was online before is now offline
                    if (ss.storage.alarmOnOff && ss.storage.followedMutedChannels.indexOf(tempInfo[i].name) < 0) {
                        alarm.set(tempInfo[i], "onOfflineChannel");
                    }
                    onlineInfo.splice(getPosByProp(onlineInfo, "name", tempInfo[i].name), 1);
                }
            }
            panelUpdate();
        }
    } else {
        //Response not found
    }
}

followedChannelUpdate = function(tempInfo = onlineInfo, offset = 0, curOnline = []) {
    //This function, when ran, will check the statuses of followed channels
    //This will also trigger alarms if the user's settings ask for them
    
	//Remove anything from the online info that is not followed anymore
	
	var followedChannels = ss.storage.followedAuthInfo.followedChannels || ss.storage.followedChannels;
	var i;
	
	var curInfo = onlineInfo.slice();
    for (i = 0; i < curInfo.length; i += 1) {
		if (getPosByProp(followedChannels, "name", curInfo[i].name) < 0) {
			onlineInfo.splice(getPosByProp(onlineInfo, "name", curInfo[i].name), 1);
		}
    }
	
    if (ss.storage.followedAuthInfo.token) {
        twitchAPI({type: "getFollowedStreams", offset: offset}, function (response) {
            if (response.json) {
                if (response.json.error === "Unauthorized") {
					if (autoLogout) {
						logout();
					}
                } else {
                    handleStreamResponse(response, tempInfo, offset, curOnline);
                }
            }
        });
    } else {
        twitchAPI({type: "checkStreams", target: genArrayFromProp(ss.storage.followedChannels, "name"), offset: offset}, function (response) {
            handleStreamResponse(response, tempInfo, offset, curOnline);
        });
    }
};

followedGameUpdate = function() {
    //This function, when ran, will check the statuses of followed games
    //This will also trigger alarms if the user's settings ask for them
    
    var responses = 0;
    var followedGames = ss.storage.followedAuthInfo.followedGames || ss.storage.followedGames;
	var i;
	
	//Remove anything from the game info that is not followed anymore
	
	var curInfo = gameInfo.slice();
    for (i = 0; i < curInfo.length; i += 1) {
		if (getPosByProp(followedGames, "name", curInfo[i].name) < 0) {
			gameInfo.splice(getPosByProp(gameInfo, "name", curInfo[i].name), 1);
		}
    }
	
    var callback = function (response) {
            responses += 1;
            if (response.json ? response.json._links: false) {
                var game = new Game(response.json);
                var key = getPosByProp(gameInfo, "name", game.name);
                if (game.online) {
                    //This is an online game
                    if (key < 0) {
                        //A game that was offline is now online
                        gameInfo.push(game);         
                        if (ss.storage.alarmOnlineGames.indexOf(game.name) < 0) {
                            ss.storage.alarmOnlineGames.push(game.name);
							if (ss.storage.alarmOnOnlineGame && ss.storage.followedMutedGames.indexOf(game.name) < 0) {
								alarm.set(game, "onOnlineGame");
							}
                        }
                    } else {
                        //A game that was online is still online
                        gameInfo[key] = game;
                    }
                } else {
                    //This is an offline game   
                    if (key > -1) {
                        //A game that was online is now offline
                        gameInfo.splice(key, 1);
                        if (ss.storage.alarmOnlineGames.indexOf(game.name) > -1) {
                            ss.storage.alarmOnlineGames.splice(ss.storage.alarmOnlineGames.indexOf(game.name), 1);
                        }
                    }
                }
            }
            if (responses >= followedGames.length) {
                //We've received a response from every game. It is safe to update the panel.
                panelUpdate();
            }
        };
    for (i = 0; i < followedGames.length; i += 1) {
        twitchAPI({type: "gameSummary", target: followedGames[i].name}, callback);
    }
};

followedVideoUpdate = function () {
    twitchAPI({type: "getFollowedVideos", offset: videoInfo.length}, function (response) {
        if (response.json) {
            if (response.json.error === "Unauthorized") {
				if (autoLogout) {
					logout();
				}
            } else {
                var videos = response.json.videos;
                for (var i = 0; i < videos.length; i += 1) {
                    var video = new Video(videos[i]);
                    var key = getPosByProp(videoInfo, "_id", video._id);
                    if (key < 0) {
                        videoInfo.push(video);
                    } else {
                        videoInfo[key] = video;
                    }
                }
            }
        }
        panelUpdate();
    });
};

function topStreamUpdate() {
    twitchAPI({type: "getTopStreams", offset: topStreamInfo.length}, function (response) {
        if (response.json) {
            var streams = response.json.streams;
            if (streams) {
                for (var i = 0; i < streams.length; i += 1) {
                    var stream = streams[i];
                    var channel = new Channel(stream);
                    var key = getPosByProp(topStreamInfo, "name", channel.name);
                    if (key < 0) {
                        topStreamInfo.push(channel);
                    } else {
                        topStreamInfo[key] = channel;
                    }
                }
            }
        }
        panelUpdate();
    });
}

function topGameUpdate() {
    twitchAPI({type: "getTopGames", offset: topGameInfo.length}, function (response) {
        if (response.json) {
            var tops = response.json.top;
            for (var i = 0; i < tops.length; i += 1) {
                var top = tops[i];
                var game = new Game(top);
                var key = getPosByProp(topGameInfo, "name", game.name);
                if (key < 0) {
                    topGameInfo.push(game);
                } else {
                    topGameInfo[key] = game;
                }
            }
        }
        panelUpdate();
    });
}

function topVideoUpdate() {
    twitchAPI({type: "getTopVideos", offset: topVideoInfo.length}, function (response) {
        if (response.json) {
            var videos = response.json.videos;
            for (var i = 0; i < videos.length; i += 1) {
                var video = new Video(videos[i]);
                var key = getPosByProp(topVideoInfo, "_id", video._id);
                if (key < 0) {
                    topVideoInfo.push(video);
                } else {
                    topVideoInfo[key] = video;
                }
            }
        }
        panelUpdate();
    });
}

function prePanelUpdate(action) {
    //This function will be called if the panel is requesting an update. It triggers functions that will update the panel when request are fulfilled
	
    if (action === "sort") {
        panelUpdate();
        return;
    }
    if (searchHistory.length) {
        if (action !== "scroll") {
            searchHistory[searchHistory.length - 1].result = [];
            searchHistory[searchHistory.length - 1].total = 0;
            searchHistory[searchHistory.length - 1].next = "";
        }
        searchTwitch(searchHistory[searchHistory.length - 1], function(newSearch) {
            searchHistory[searchHistory.length - 1] = newSearch;
            panelUpdate();
        });
        return;
    }
	
    switch (ss.storage.interMode) {
        case "channels":
            if (ss.storage.interFollowedMode) {
                if (action === "refresh") {
                    onlineInfo = [];
                }
                update();
            } else {
                if (action !== "scroll") {
                    topStreamInfo = [];
                }
                topStreamUpdate();
            }
            break;
        case "games":
            if (ss.storage.interFollowedMode) {
                if (action === "refresh") {
                    gameInfo = [];
                }
                update();
            } else {
                if (action !== "scroll") {
                    topGameInfo = [];
                }
                topGameUpdate();
            }
            break;
        case "videos":
            if (ss.storage.interFollowedMode) {
                if (action !== "scroll") {
                    videoInfo = [];
                }
                followedVideoUpdate();
            } else {
                if (action !== "scroll") {
                    topVideoInfo = [];
                }
                topVideoUpdate();
            }
            break;
    }
}

update = function () {
    //This function is called every how many seconds as defined in the options
    
    if (ss.storage.followedAuthInfo.token) {
        //Actions to perform if the user is authorized
        authSync();
    } else {
        //Actions to perform if the user is not authorized
        
        //Update followed channels
        if (ss.storage.alarmOnOnlineChannel || ss.storage.alarmOnOfflineChannel || ss.storage.alarmOnStatusChange || panel.isShowing) {
            //Only bother updating if the user has any interest in receiving one
            followedChannelUpdate();
        }

        //Update followed games
        if (ss.storage.alarmOnOnlineGame || panel.isShowing) {
            //Only bother updating if the user has any interest in receiving one

            followedGameUpdate();
        }
    }
};
   
function onAddonLoad() {
	cleanSettings();
	checkFollowedChannels();
	livestreamerHandler.checkIfReady();
	alarmHandler.port.emit("update", ss.storage, OS.Path.toFileURI(ss.storage.alarmPath.replace("\\", "\\\\")));
	panel.port.emit("settingsUpdate", ss.storage);
	update();
}

exports.onUnload = function (reason) {
    //if (reason === "disable" || reason === "uninstall") {
	if (reason === "uninstall") { //Hopefully Mozilla fixes this... people are losing settings by disabling and re-enabling
        //onAddonRemoved
        for (var key in ss.storage) {
            if (ss.storage.hasOwnProperty(key)) {
                delete ss.storage[key];
            }
        }
    } else if (reason === "upgrade") {
        //onNewVersion
    } else {
        //onBrowserClose
    }
};

ss.on("OverQuota", function() {
    delete ss.storage.alarmStreamIds;
    ss.storage.alarmStreamIds = [];
    delete ss.storage.alarmOnlineGames;
    ss.storage.alarmOnlineGames = [];
});

//Define the panel, as well as any generic messages we might receieve from the panel

panel = panels.Panel({
    contentURL: self.data.url("twitchFox.html"),
    width: 500,
    height: 530,
	position: button,
    onHide: onPanelClose,
	onShow: onPanelOpen,
});

panel.port.on("openProfile", function () {
    if (ss.storage.followedAuthInfo.token) {
        tabs.open("http://www.twitch.tv/" + ss.storage.followedAuthInfo.name + "/profile");
    }
});

panel.port.on("openTab", function (payload) {
    tabs.open("http://www.twitch.tv/" + payload);
    panel.port.emit("openTab");
});

panel.port.on("getQualities", function (payload) {
    //We're expecting a string of the stream's name
    livestreamerHandler.getQualities(payload, function(results) {
		panel.port.emit("getQualities", results);
	});
});

panel.port.on("openLive", function (payload) {
    //We're expecting an object with the desired arguments 
    livestreamerHandler.run(["http://www.twitch.tv/" + payload.url, payload.quality]);
});

panel.port.on("openLiveUncertain", function (payload) {
    livestreamerHandler.getQualities(payload.url, function(results) {
		if (results.indexOf(payload.quality) > -1) {
			//Our quality is safe to use
			livestreamerHandler.run(["http://www.twitch.tv/" + payload.url, payload.quality]);
		} else {
			//Our quality is not usable. Default to the best quality available
			livestreamerHandler.run(["http://www.twitch.tv/" + payload.url, results[0]]);
		}
	});
});

panel.port.on("login", login);

panel.port.on("logout", logout);

panel.port.on("followChannel", followChannel);

panel.port.on("followChannels", function(payload) {
	for (var i = 0; i < payload.length; i += 1) {
		followChannel(payload[i]);
	}
});

panel.port.on("unfollowChannel", unfollowChannel);

panel.port.on("unfollowChannels", function(payload) {
	for (var i = 0; i < payload.length; i += 1) {
		unfollowChannel(payload[i]);
	}
});

panel.port.on("followGame", followGame);

panel.port.on("unfollowGame", unfollowGame);

panel.port.on("infoUpdate", prePanelUpdate);

panel.port.on("searchTwitch", function (payload) {
    var thisSearch = new Search(payload.type || ss.storage.interMode, payload.target, true);
    if (searchHistory.length) {
        searchHistory[searchHistory.length - 1].scrollY = payload.scrollY;
		searchHistory[searchHistory.length - 1].prompt = payload.prompt;
    }
    searchHistory.push(thisSearch);
    panel.port.emit("searchTwitch", searchHistory);
});

panel.port.on("searchDirectory", function (payload) {
    var thisSearch = new Search(payload.type, payload.target);
    if (searchHistory.length) {
		//These searches operate on the same level, so let's make sure they don't add onto eachother
        var thisType = thisSearch.type === "getBroadcasts" ? "getHighlights" : thisSearch.type;
		var thatType = searchHistory[searchHistory.length - 1].type === "getBroadcasts" ? "getHighlights" : searchHistory[searchHistory.length - 1].type;
		thisType = thisSearch.type === "streams" ? "channels" : thisSearch.type;
		thatType = searchHistory[searchHistory.length - 1].type === "streams" ? "channels" : searchHistory[searchHistory.length - 1].type;
        if (thisType === thatType && searchHistory[searchHistory.length - 1].target === thisSearch.target) {
            panel.port.emit("searchDirectory", searchHistory);
            return;
        }
        searchHistory[searchHistory.length - 1].scrollY = payload.scrollY;
		searchHistory[searchHistory.length - 1].prompt = payload.prompt;
    }
    searchHistory.push(thisSearch);
    panel.port.emit("searchDirectory", searchHistory);
});

panel.port.on("searchBack", function () {
    if (searchHistory.length) {
        searchHistory.pop();
    }
    panel.port.emit("searchBack", searchHistory);
});

panel.port.on("endSearch", function () {
    searchHistory = [];
    panel.port.emit("endSearch", searchHistory);
});

panel.port.on("settingsUpdate", function (payload) {
    ss.storage[payload.prop] = payload.val;
	if (payload.alarmUpdate) {
		alarmHandler.port.emit("update", ss.storage, OS.Path.toFileURI(ss.storage.alarmPath.replace("\\", "\\\\")));
		if (!ss.storage.alarmSound || alarm.restricted() || ss.storage.alarmDisableIconFlashing) {
			alarm.end();
		}
	}
    panel.port.emit("settingsUpdate", ss.storage);
});

panel.port.on("toggleSettingsMode", function () {
    settingsMode = !settingsMode;
    panel.port.emit("toggleSettingsMode", settingsMode);
});

panel.port.on("muteChannel", function (payload) {
    if (ss.storage.followedMutedChannels.indexOf(payload) < 0) {
        ss.storage.followedMutedChannels.push(payload);
    }
	panel.port.emit("settingsUpdate", ss.storage);
});

panel.port.on("muteChannels", function(payload) {
	for (var i = 0; i < payload.length; i += 1) {
		if (ss.storage.followedMutedChannels.indexOf(payload[i]) < 0) {
			ss.storage.followedMutedChannels.push(payload[i]);
		}
	}
	panel.port.emit("settingsUpdate", ss.storage);
});

panel.port.on("unmuteChannel", function (payload) {
    var key = ss.storage.followedMutedChannels.indexOf(payload);
    if (key > -1) {
        ss.storage.followedMutedChannels.splice(key, 1);
    }
	panel.port.emit("settingsUpdate", ss.storage);
});

panel.port.on("unmuteChannels", function(payload) {
	for (var i = 0; i < payload.length; i += 1) {
		var key = ss.storage.followedMutedChannels.indexOf(payload[i]);
		if (key > -1) {
			ss.storage.followedMutedChannels.splice(key, 1);
		}
	}
	panel.port.emit("settingsUpdate", ss.storage);
});

panel.port.on("muteGame", function (payload) {
    if (ss.storage.followedMutedGames.indexOf(payload) < 0) {
        ss.storage.followedMutedGames.push(payload);
    }
	panel.port.emit("settingsUpdate", ss.storage);
});

panel.port.on("unmuteGame", function (payload) {
    var key = ss.storage.followedMutedGames.indexOf(payload);
    if (key > -1) {
        ss.storage.followedMutedGames.splice(key, 1);
    }
	panel.port.emit("settingsUpdate", ss.storage);
});

panel.port.on("importSettings", function (payload) {
	ss.storage = payload;
	onAddonLoad();
});

panel.port.on("importFollows", function (payload) {
	importFollowedChannels(function(channels) {
		for (var i = 0; i < channels.length; i += 1) {
			if (getPosByProp(ss.storage.followedChannels, "name", channels[i].name) < 0) {
				ss.storage.followedChannels.push(channels[i]);
			}
		}
		importFollowedGames(function(games) {
			for (var i = 0; i < games.length; i += 1) {
				if (getPosByProp(ss.storage.followedGames, "name", games[i].name) < 0) {
					ss.storage.followedGames.push(games[i]);
				}
			}
			panel.port.emit("settingsUpdate", ss.storage);
			update();
		}, payload);
	}, payload);
});

panel.port.on("clearFollows", function() {
	ss.storage.followedChannels = [];
	panel.port.emit("settingsUpdate", ss.storage);
	update();
});

panel.port.on("alarmDefaults", function() {
	ss.storage.alarmDisableIconFlashing = false;
	ss.storage.alarmInterval = 1;
	ss.storage.alarmLength = 10;
	ss.storage.alarmLimit = false;
	ss.storage.alarmNotifs = true;
	ss.storage.alarmOnOfflineChannel = false;
	ss.storage.alarmOnOnlineChannel = true;
	ss.storage.alarmOnOnlineGame = false;
	ss.storage.alarmOnStatusChange = false;
	ss.storage.alarmPath = "";
	ss.storage.alarmRestrict = false;
	ss.storage.alarmRestrictFrom = "22:00:00";
	ss.storage.alarmRestrictTo = "06:00:00";
	ss.storage.alarmSound = true;
	ss.storage.alarmUpdate = 60;
	ss.storage.alarmVolume = 50;
	alarmHandler.port.emit("update", ss.storage, OS.Path.toFileURI(ss.storage.alarmPath.replace("\\", "\\\\")));
	panel.port.emit("settingsUpdate", ss.storage);
});

panel.port.on("interfaceDefaults", function() {
	ss.storage.interDarkMode = false;
	ss.storage.interHideAvatar = false;
	ss.storage.interHideOffline = false;
	ss.storage.interHidePreview = false;
	ss.storage.interLivestreamerPath = "";
	ss.storage.interLivestreamerQuality = "best";
	ss.storage.interOpenChat = false;
	ss.storage.interOpenLive = false;
	ss.storage.interOpenPage = false;
	ss.storage.interOpenPopout = false;
	ss.storage.interOpenPopup = true;
	ss.storage.interSearchLim = 20;
	livestreamerHandler.checkIfReady();
});

panel.port.on("newLivePath", function(path) {
	ss.storage.interLivestreamerPath = path;
	livestreamerHandler.checkIfReady();
});

panel.port.on("panelReady", function() {
	panel.port.emit("l10n", {
		custom2: _("custom2"),
		filterAdd: _("filterAdd"),
		filterFollowedChannels: _("filterChannels"),
		filterFollowedGames: _("filterGames"),
		filterFollowedVideos: _("filterVideos"),
		filterSearchResults: _("filterResults"),
		filterVideos: _("searchVids"),
		importFollowed: _("importFollowed"),
		leaveBlank: _("leaveBlank"),
		livestreamerNotFound: _("livestreamerNotFound"),
		livestreamerReady: _("livestreamerReady"),
		loggedIn: _("loggedIn"),
		onlineFor: _("streamingFor"),
		recorded: _("recorded"),
		searchChannels: _("searchStreamers"),
		searchGames: _("searchGames"),
		searching: _("searching"),
		separator: _("separator"),
		version: self.version,
		versionWord: _("version"),
	});
	
	panel.port.emit("settingsUpdate", ss.storage);
	
	prePanelUpdate();
});

//End of panel ports

//Stuff that needs to be done every time the add-on is loaded

onAddonLoad();

updateInterval = setInterval(update, ss.storage.alarmUpdate * 1000);