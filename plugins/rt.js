/*
 * Copyright (c) 2011, Yahoo! Inc.  All rights reserved.
 * Copyright (c) 2012, Log-Normal, Inc.  All rights reserved.
 * Copyrights licensed under the BSD License. See the accompanying LICENSE.txt file for terms.
 */

// This is the Round Trip Time plugin.  Abbreviated to RT
// the parameter is the window
(function(w) {

var d=w.document;

BOOMR = BOOMR || {};
BOOMR.plugins = BOOMR.plugins || {};

// private object
var impl = {
	complete: false,	//! Set when this plugin has completed

	timers: {},		//! Custom timers that the developer can use
				// Format for each timer is { start: XXX, end: YYY, delta: YYY-XXX }
	cookie: 'RT',		//! Name of the cookie that stores the start time and referrer
	cookie_exp:600,		//! Cookie expiry in seconds
	strict_referrer: true,	//! By default, don't beacon if referrers don't match.
				// If set to false, beacon both referrer values and let
				// the back end decide

	navigationType: 0,
	navigationStart: undefined,
	responseStart: undefined,
	t_start: undefined,
	r: undefined,
	r2: undefined,

	setCookie: function() {
		var t_end, t_start = new Date().getTime();

		// Disable use of RT cookie by setting its name to a falsy value
		if(!this.cookie) {
			return this;
		}

		// We use document.URL instead of location.href because of a bug in safari 4
		// where location.href is URL decoded
		if(!BOOMR.utils.setCookie(this.cookie,
						{ s: t_start, r: d.URL.replace(/#.*/, '') },
						this.cookie_exp)
		) {
			BOOMR.error("cannot set start cookie", "rt");
			return this;
		}

		t_end = new Date().getTime();
		if(t_end - t_start > 50) {
			// It took > 50ms to set the cookie
			// The user Most likely has cookie prompting turned on so
			// t_start won't be the actual unload time
			// We bail at this point since we can't reliably tell t_done
			BOOMR.utils.removeCookie(this.cookie);

			// at some point we may want to log this info on the server side
			BOOMR.error("took more than 50ms to set cookie... aborting: "
					+ t_start + " -> " + t_end, "rt");
		}

		return this;
	},

	initFromCookie: function() {
		var subcookies;

		// A beacon may be fired automatically on page load or if the page dev fires
		// it manually with their own timers.  It may not always contain a referrer
		// (eg: XHR calls).  We set default values for these cases

		this.r = this.r2 = d.referrer.replace(/#.*/, '');

		if(!this.cookie) {
			return;
		}

		subcookies = BOOMR.utils.getSubCookies(BOOMR.utils.getCookie(this.cookie));

		if(!subcookies) {
			return;
		}

		if(subcookies.s && subcookies.r) {
			this.r = subcookies.r;
			if(!this.strict_referrer || this.r === this.r2) {
				this.t_start = parseInt(subcookies.s, 10);
			}
		}

	},

	checkPreRender: function() {
		if(
			!(d.webkitVisibilityState && d.webkitVisibilityState === "prerender")
			&&
			!(d.msVisibilityState && d.msVisibilityState === 3)
		) {
			return false;
		}

		// This means that onload fired through a pre-render.  We'll capture this
		// time, but wait for t_done until after the page has become either visible
		// or hidden (ie, it moved out of the pre-render state)
		// http://code.google.com/chrome/whitepapers/pagevisibility.html
		// http://www.w3.org/TR/2011/WD-page-visibility-20110602/
		// http://code.google.com/chrome/whitepapers/prerender.html

		BOOMR.plugins.RT.startTimer("t_load", this.navigationStart);
		BOOMR.plugins.RT.endTimer("t_load");					// this will measure actual onload time for a prerendered page
		BOOMR.plugins.RT.startTimer("t_prerender", this.navigationStart);
		BOOMR.plugins.RT.startTimer("t_postrender");				// time from prerender to visible or hidden

		BOOMR.subscribe("visibility_changed", BOOMR.plugins.RT.done, null, BOOMR.plugins.RT);

		return true;
	},

	initNavTiming: function() {
		var ti, p, source;

		if(this.navigationStart) {
			return;
		}

		// Get start time from WebTiming API see:
		// https://dvcs.w3.org/hg/webperf/raw-file/tip/specs/NavigationTiming/Overview.html
		// http://blogs.msdn.com/b/ie/archive/2010/06/28/measuring-web-page-performance.aspx
		// http://blog.chromium.org/2010/07/do-you-know-how-slow-your-web-page-is.html
		p = w.performance || w.msPerformance || w.webkitPerformance || w.mozPerformance;

		if(p && p.navigation) {
			this.navigationType = p.navigation.type;
		}

		if(p && p.timing) {
			ti = p.timing;
		}
		else if(w.chrome && w.chrome.csi && w.chrome.csi().startE) {
			// Older versions of chrome also have a timing API that's sort of documented here:
			// http://ecmanaut.blogspot.com/2010/06/google-bom-feature-ms-since-pageload.html
			// source here:
			// http://src.chromium.org/viewvc/chrome/trunk/src/chrome/renderer/loadtimes_extension_bindings.cc?view=markup
			ti = {
				navigationStart: w.chrome.csi().startE
			};
			source = "csi";
		}
		else if(w.gtbExternal && w.gtbExternal.startE()) {
			// The Google Toolbar exposes navigation start time similar to old versions of chrome
			// This would work for any browser that has the google toolbar installed
			ti = {
				navigationStart: w.gtbExternal.startE()
			};
			source = 'gtb';
		}

		if(ti) {
			// Always use navigationStart since it falls back to fetchStart (not with redirects)
			// If not set, we leave t_start alone so that timers that depend
			// on it don't get sent back.  Never use requestStart since if
			// the first request fails and the browser retries, it will contain
			// the value for the new request.
			BOOMR.addVar("rt.start", source || "navigation");
			this.navigationStart = ti.navigationStart || ti.fetchStart || undefined;
			this.responseStart = ti.responseStart || undefined;

			// bug in Firefox 7 & 8 https://bugzilla.mozilla.org/show_bug.cgi?id=691547
			if(navigator.userAgent.match(/Firefox\/[78]\./)) {
				this.navigationStart = ti.unloadEventStart || ti.fetchStart || undefined;
			}
		}
		else {
			BOOMR.warn("This browser doesn't support the WebTiming API", "rt");
		}

		return;
	},

	domloaded: function() {
		BOOMR.plugins.RT.endTimer("t_domloaded");
	}
};

BOOMR.plugins.RT = {
	// Methods

	init: function(config) {
		BOOMR.utils.pluginConfig(impl, config, "RT",
					["cookie", "cookie_exp", "strict_referrer"]);

		// if complete is already true
		// then we've already collected t_done so no point running init
		if(impl.complete) {
			return this;
		}

		impl.complete = false;
		impl.timers = {};

		BOOMR.subscribe("page_ready", this.done, null, this);
		BOOMR.subscribe("dom_loaded", impl.domloaded, null, impl);
		BOOMR.subscribe("page_unload", impl.setCookie, null, impl);

		if(BOOMR.t_start) {
			// How long does it take Boomerang to load up and execute
			this.startTimer('boomerang', BOOMR.t_start);
			this.endTimer('boomerang', BOOMR.t_end);	// t_end === null defaults to current time

			// How long did it take till Boomerang started
			this.endTimer('boomr_fb', BOOMR.t_start);
		}

		return this;
	},

	startTimer: function(timer_name, time_value) {
		if(timer_name) {
			if (timer_name === 't_page') {
				this.endTimer('t_resp', time_value);
			}
			impl.timers[timer_name] = {start: (typeof time_value === "number" ? time_value : new Date().getTime())};
			impl.complete = false;
		}

		return this;
	},

	endTimer: function(timer_name, time_value) {
		if(timer_name) {
			impl.timers[timer_name] = impl.timers[timer_name] || {};
			if(!("end" in impl.timers[timer_name])) {
				impl.timers[timer_name].end =
						(typeof time_value === "number" ? time_value : new Date().getTime());
			}
		}

		return this;
	},

	setTimer: function(timer_name, time_delta) {
		if(timer_name) {
			impl.timers[timer_name] = { delta: time_delta };
		}

		return this;
	},

	// Called when the page has reached a "usable" state.  This may be when the
	// onload event fires, or it could be at some other moment during/after page
	// load when the page is usable by the user
	done: function() {
		var t_start, t_done=new Date().getTime(),
		    basic_timers = { t_done: 1, t_resp: 1, t_page: 1},
		    ntimers = 0, t_name, timer, t_other=[];

		impl.complete = false;

		impl.initNavTiming();

		if(impl.checkPreRender()) {
			return this;
		}

		if(impl.responseStart) {
			// Use NavTiming API to figure out resp latency and page time
			// t_resp will use the cookie if available or fallback to NavTiming
			this.endTimer("t_resp", impl.responseStart);
			if(impl.timers.t_load) {
				this.setTimer("t_page", impl.timers.t_load.end - impl.responseStart);
			}
			else {
				this.setTimer("t_page", t_done - impl.responseStart);
			}
		}
		else if(impl.timers.hasOwnProperty('t_page')) {
			// If the dev has already started t_page timer, we can end it now as well
			this.endTimer("t_page");
		}

		// If a prerender timer was started, we can end it now as well
		if(impl.timers.hasOwnProperty('t_postrender')) {
			this.endTimer("t_postrender");
			this.endTimer("t_prerender");
		}

		if(impl.navigationStart) {
			t_start = impl.navigationStart;
		}
		else if(impl.t_start && impl.navigationType !== 2) {
			t_start = impl.t_start;			// 2 is TYPE_BACK_FORWARD but the constant may not be defined across browsers
			BOOMR.addVar("rt.start", "cookie");	// if the user hit the back button, referrer will match, and cookie will match
		}						// but will have time of previous page start, so t_done will be wrong
		else {
			BOOMR.addVar("rt.start", "none");
			t_start = undefined;			// force all timers to NaN state
		}

		impl.initFromCookie();

		// If the dev has already called endTimer, then this call will do nothing
		// else, it will stop the page load timer
		this.endTimer("t_done", t_done);

		// make sure old variables don't stick around
		BOOMR.removeVar('t_done', 't_page', 't_resp', 'r', 'r2', 'rt.tstart', 'rt.bstart', 'rt.end', 't_postrender', 't_prerender', 't_load');

		BOOMR.addVar('rt.tstart', t_start);
		BOOMR.addVar('rt.bstart', BOOMR.t_start);
		BOOMR.addVar('rt.end', impl.timers.t_done.end);	// don't just use t_done because dev may have called endTimer before we did

		for(t_name in impl.timers) {
			if(!impl.timers.hasOwnProperty(t_name)) {
				continue;
			}

			timer = impl.timers[t_name];

			// if delta is a number, then it was set using setTimer
			// if not, then we have to calculate it using start & end
			if(typeof timer.delta !== "number") {
				if(typeof timer.start !== "number") {
					timer.start = t_start;
				}
				timer.delta = timer.end - timer.start;
			}

			// If the caller did not set a start time, and if there was no start cookie
			// Or if there was no end time for this timer,
			// then timer.delta will be NaN, in which case we discard it.
			if(isNaN(timer.delta)) {
				continue;
			}

			if(basic_timers.hasOwnProperty(t_name)) {
				BOOMR.addVar(t_name, timer.delta);
			}
			else {
				t_other.push(t_name + '|' + timer.delta);
			}
			ntimers++;
		}

		if(ntimers) {
			BOOMR.addVar("r", impl.r);

			if(impl.r2 !== impl.r) {
				BOOMR.addVar("r2", impl.r2);
			}

			if(t_other.length) {
				BOOMR.addVar("t_other", t_other.join(','));
			}
		}

		impl.timers = {};
		impl.complete = true;

		BOOMR.sendBeacon();	// we call sendBeacon() anyway because some other plugin
					// may have blocked waiting for RT to complete
		return this;
	},

	is_complete: function() { return impl.complete; }

};

}(window));
// End of RT plugin


