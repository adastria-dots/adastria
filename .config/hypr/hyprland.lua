-- HYPRLAND CONFIG

local B = require("utils.bootstrap")
local T = require("utils.tiling")

-- =========
-- COLORS
-- =========
local col = (function()
	local path = os.getenv("HOME") .. "/.config/keqing-shell/colors.json"
	local f = io.open(path, "r")
	local _c = {}

	if f then
		local content = f:read("*a")
		f:close()
		local current = content:match('"current"%s*:%s*(%b{})')
		if current then
			for key, value in current:gmatch('"(%w+)"%s*:%s*"(#[%x]+)"') do
				_c[key] = value
			end
		end
	end

	return {
		-- dark range (color0–7)
		base = _c.base or "#0A0614",
		surface = _c.surface or "#110B22",
		surfaceAlt = _c.surfaceAlt or "#1A1238",
		accentAltContainer = _c.accentAltContainer or "#2B1D5C",
		accentContainer = _c.accentContainer or "#3D1878",
		lavender = _c.lavender or "#5E50A0",
		textDim = _c.lavender or "#5E50A0",
		rose = _c.rose or "#7A4A58",
		textMuted = _c.textMuted or "#A896C8",
		-- bright range (color8–15)
		fieldBg = _c.fieldBg or "#0F1535",
		overlay = _c.overlay or "#1C1848",
		overlayAlt = _c.overlayAlt or "#252060",
		accentAlt = _c.accentAlt or "#C8942A",
		accentDim = _c.accentDim or "#5535B8",
		accent = _c.accent or "#7B2FE8",
		lavenderLight = _c.lavenderLight or "#C87EFF",
		text = _c.text or "#F0ECF8",
	}
end)()

-- =========
-- VARIABLES
-- =========
local V = {}

V.col = col

-- Home
V.home = os.getenv("HOME")

-- Core
V.root = V.home .. "/keqing-dots"
V.wpm = 10

-- Applications
V.terminal = "kitty"
V.browser = "zen-browser"
V.browser_private = "zen-browser --private"
V.editor = "code"
V.filemanager = V.terminal .. " yazi"
V.screenshot = "bash -c 'mkdir -p $HOME/Pictures/screenshots/ && hyprshot -m region -o $HOME/Pictures/screenshots/'"

-- Keqing-shell IPC Calls
V.qs = "keqing-shell "
V.control = V.qs .. "controlcenter"
V.launcher = V.qs .. "launcher"
V.lock = V.qs .. "lock"
V.logout = V.qs .. "logout"
V.matrix = V.qs .. "matrix"
V.overview = V.qs .. "overview"
V.settings = V.qs .. "settings"
V.visualizer = V.qs .. "visualizer"

-- =====================
-- ENVIRONMENT VARIABLES
-- =====================
for k, v in pairs({
	-- Core
	KEQING_DOTS_ROOT = V.root,
	WORKSPACES_PER_MONITOR = V.wpm,

	-- Cursor themes
	HYPRCURSOR_THEME = "Keqing",
	HYPRCURSOR_SIZE = "24",
	XCURSOR_THEME = "Keqing",
	XCURSOR_SIZE = "24",

	-- Input method
	QT_IM_MODULE = "fcitx",
	XMODIFIERS = "@im=fcitx",
	INPUT_METHOD = "fcitx",
	SDL_IM_MODULE = "fcitx",

	-- Toolkit
	XDG_MENU_PREFIX = "arch-",
	QT_QPA_PLATFORMTHEME = "qt6ct",
	GTK_THEME = "Adwaita:dark",
	GTK_APPLICATION_PREFER_DARK_THEME = "1",
	QT_STYLE_OVERRIDE = "Fusion",
	QT_QUICK_CONTROLS_STYLE = "Fusion",
	QT_THEME = "dark",

	-- Session
	XDG_CURRENT_DESKTOP = "Hyprland",
	XDG_SESSION_DESKTOP = "Hyprland",
	XDG_SESSION_TYPE = "wayland",

	-- Wayland
	QT_QPA_PLATFORM = "wayland;xcb",
	GDK_BACKEND = "wayland,x11",
	MOZ_ENABLE_WAYLAND = "1",
	GTK_USE_PORTAL = "1",
}) do
	hl.env(k, v)
end

-- ==========
-- ANIMATIONS
-- ==========
for name, points in pairs({
	quick = { { 0.15, 0 }, { 0.1, 1 } },
	linear = { { 0, 0 }, { 1, 1 } },
}) do
	hl.curve(name, { type = "bezier", points = points })
end

for _, anim in ipairs({
	{ leaf = "global", enabled = false },
	{ leaf = "fadeIn", speed = 1.5, bezier = "linear" },
	{ leaf = "fadeOut", speed = 1.5, bezier = "linear" },
	{ leaf = "windowsIn", speed = 1.5, bezier = "linear", style = "popin 85%" },
	{ leaf = "windowsOut", speed = 1.5, bezier = "linear", style = "popin 85%" },
	{ leaf = "windowsMove", speed = 2.0, bezier = "quick" },
	{ leaf = "workspaces", speed = 2.5, bezier = "quick", style = "slidevert" },
}) do
	if anim.enabled == nil then anim.enabled = true end
	hl.animation(anim)
end

-- ========
-- SETTINGS
-- ========
hl.config({
	general = {
		border_size = 5,
		allow_tearing = false,
		gaps_in = 10,
		gaps_out = 20,
		resize_on_border = true,

		col = {
			active_border = { colors = { V.col.accent .. "EE", V.col.lavender .. "EE" }, angle = 45 },
			inactive_border = V.col.textDim .. "AA",
		},
	},

	decoration = {
		rounding = 10,
		rounding_power = 2,

		active_opacity = 1.0,
		inactive_opacity = 1.0,

		blur = {
			enabled = false,
		},
	},

	animations = {
		enabled = true,
	},

	input = {
		kb_layout = "us",
		follow_mouse = 1,
		sensitivity = 0,

		touchpad = {
			natural_scroll = true,
			disable_while_typing = true,
			tap_to_click = true,
			drag_lock = 0,
			scroll_factor = 1.0,
		},
	},

	cursor = {
		enable_hyprcursor = true,
		no_hardware_cursors = 1,
		use_cpu_buffer = 2,
	},

	misc = {
		animate_mouse_windowdragging = true,
		disable_hyprland_logo = true,
		disable_splash_rendering = true,
		force_default_wallpaper = 0,
		middle_click_paste = false,
	},

	xwayland = {
		force_zero_scaling = true,
	},
})

-- ======================
-- INITIAL MONITOR CONFIG
-- ======================
hl.monitor({ output = "", mode = "preferred", position = "0x0", scale = 1, transform = 0 })

-- ========
-- GESTURES
-- ========
hl.gesture({ fingers = 3, direction = "horizontal", action = "workspace" })

-- ============
-- WINDOW RULES
-- ============
hl.window_rule({ match = { fullscreen = true }, border_color = V.col.accentAlt })
hl.window_rule({ match = { float = true }, border_color = V.col.text })
hl.window_rule({ match = { class = "code-oss" }, opacity = "0.7" })

-- ===========
-- KEYBINDINGS
-- ===========

-- keqing-shell
for k, v in pairs({
	[B.mod("C", "s")] = hl.dsp.exec_cmd(V.control),
	[B.mod("I")] = hl.dsp.exec_cmd(V.settings),
	[B.mod("L")] = hl.dsp.exec_cmd(V.lock),
	[B.mod("M")] = hl.dsp.exec_cmd(V.matrix),
	[B.mod("Q")] = hl.dsp.exec_cmd(V.logout),
	[B.mod("V", "s")] = hl.dsp.exec_cmd(V.visualizer),
	[B.mod("TAB")] = hl.dsp.exec_cmd(V.overview),
	["SHIFT + SPACE"] = hl.dsp.exec_cmd(V.launcher),
}) do
	hl.bind(k, v)
end

-- Window states
for k, v in pairs({
	[B.mod("F")] = hl.dsp.window.fullscreen({ mode = "maximized", action = "toggle" }),
	[B.mod("F", "s")] = hl.dsp.window.fullscreen({ mode = "fullscreen", action = "toggle" }),
	[B.mod("P")] = hl.dsp.window.pseudo(),
	[B.mod("V")] = hl.dsp.window.float({ action = "toggle" }),
}) do
	hl.bind(k, v)
end

-- Apps
for k, v in pairs({
	[B.mod("B")] = hl.dsp.exec_cmd(V.browser),
	[B.mod("B", "s")] = hl.dsp.exec_cmd(V.browser_private),
	[B.mod("C")] = hl.dsp.exec_cmd(V.editor),
	[B.mod("E")] = hl.dsp.exec_cmd(V.filemanager),
	[B.mod("K", "a")] = hl.dsp.exec_cmd(V.editor .. " keqing-shell"),
	[B.mod("K", "s")] = hl.dsp.exec_cmd(V.editor .. " keqing-dots"),
	[B.mod("S", "s")] = hl.dsp.exec_cmd(V.screenshot),
	[B.mod("T")] = hl.dsp.exec_cmd(V.terminal),
}) do
	hl.bind(k, v)
end

-- Window operations
for k, v in pairs({
	[B.mod("down")] = hl.dsp.focus({ direction = "d" }),
	[B.mod("down", "s")] = function() T.adaptive_move("d") end,
	[B.mod("left")] = hl.dsp.focus({ direction = "l" }),
	[B.mod("left", "s")] = function() T.adaptive_move("l") end,
	[B.mod("right")] = hl.dsp.focus({ direction = "r" }),
	[B.mod("right", "s")] = function() T.adaptive_move("r") end,
	[B.mod("up")] = hl.dsp.focus({ direction = "u" }),
	[B.mod("up", "s")] = function() T.adaptive_move("u") end,
	[B.mod("W")] = hl.dsp.window.close(),
}) do
	hl.bind(k, v, { repeating = true })
end

-- Workspace operations
for i = 1, V.wpm do
	local k = i % V.wpm
	hl.bind(B.mod(k), function() T.fw(i) end)
	hl.bind(B.mod(k, "c"), function() T.sw(i) end)
	hl.bind(B.mod(k, "s"), function() T.mw(i) end)
end

-- Media
for k, v in pairs({
	["XF86AudioLowerVolume"] = hl.dsp.exec_cmd("wpctl set-volume @DEFAULT_AUDIO_SINK@ 1%-"),
	["XF86AudioMicMute"] = hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle"),
	["XF86AudioMute"] = hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle"),
	["XF86AudioRaiseVolume"] = hl.dsp.exec_cmd("wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ 1%+"),
	["XF86MonBrightnessDown"] = hl.dsp.exec_cmd("brightnessctl -e4 -n2 set 1%-"),
	["XF86MonBrightnessUp"] = hl.dsp.exec_cmd("brightnessctl -e4 -n2 set 1%+"),
}) do
	hl.bind(k, v, { locked = true, repeating = true })
end

-- Mouse
for k, v in pairs({
	[B.mod("mouse:272")] = hl.dsp.window.drag(),
	[B.mod("mouse:273")] = hl.dsp.window.resize(),
}) do
	hl.bind(k, v, { mouse = true })
end

B.load_device()
