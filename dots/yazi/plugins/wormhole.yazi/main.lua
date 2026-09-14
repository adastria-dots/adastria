local TITLE = "Wormhole"

local GET_TARGETS = ya.sync(function()
	local urls = {}

	-- yazi >=26: iterating cx.yanked / cx.active.selected yields File objects,
	-- so take .url (tostring on the File itself gives "File: 0x...").
	if cx.yanked then
		for _, f in pairs(cx.yanked) do
			urls[#urls + 1] = tostring(f.url)
		end
	end

	if #urls == 0 and cx.active.selected then
		for _, f in pairs(cx.active.selected) do
			urls[#urls + 1] = tostring(f.url)
		end
	end

	if #urls == 0 then
		local hovered = cx.active.current.hovered
		if hovered then
			urls[1] = tostring(hovered.url)
		end
	end

	return urls
end)

local HAS_YANKED = ya.sync(function()
	if cx.yanked then
		for _ in pairs(cx.yanked) do
			return true
		end
	end
	return false
end)

local CURRENT_CWD = ya.sync(function()
	return tostring(cx.active.current.cwd)
end)

local function notify(level, content, timeout)
	local entry = { title = TITLE, content = content, timeout = timeout or 2 }
	if level then
		entry.level = level
	end
	ya.notify(entry)
end

local function normalize_path(s)
	if s == nil then
		return nil
	end
	s = tostring(s):gsub("\r", ""):gsub("\n", "")
	s = s:gsub("^file://localhost", "")
	s = s:gsub("^file://", "")
	s = s:gsub("%%(%x%x)", function(h)
		return string.char(tonumber(h, 16))
	end)
	return s
end

local function basename(path)
	return (path or ""):gsub("/+$", ""):match("([^/]+)$")
end

-- Percent-encode a filesystem path into a file:// URI, the way yazi itself does
-- for drag-and-drop. This is the format GUI file managers exchange as
-- text/uri-list.
local function path_to_uri(path)
	return "file://" .. ya.percent_encode(tostring(path))
end

local function state_path()
	local home = os.getenv("HOME") or "."
	local state_home = os.getenv("XDG_STATE_HOME") or (home .. "/.local/state")
	return state_home .. "/yazi/wormhole"
end

local function ensure_state_dir(path)
	local dir = path:match("^(.*)/[^/]+$")
	if not dir then
		return
	end
	pcall(function()
		fs.create("dir_all", Url(dir))
	end)
end

local function write_mode(mode)
	local path = state_path()
	ensure_state_dir(path)
	fs.write(Url(path), tostring(mode) .. "\n")
end

local function read_mode()
	local path = state_path()
	local out, _ = Command("cat"):arg(path):output()
	if not out or not out.status.success then
		return "copy"
	end
	local mode = (out.stdout or ""):match("^(%S+)")
	if mode ~= "cut" and mode ~= "copy" then
		return "copy"
	end
	return mode
end

local function clear_state()
	local path = state_path()
	Command("rm"):arg({ "-f", path }):status()
end

local function wl_copy(paths)
	local lines = {}
	for _, p in ipairs(paths) do
		lines[#lines + 1] = path_to_uri(p)
	end
	local status, err = Command("wl-copy")
		:arg({ "--type", "text/uri-list", "--", table.concat(lines, "\r\n") })
		:status()
	if not status then
		return false, err
	end
	return status.success, nil
end

local function wl_paste()
	for _, t in ipairs({ "text/uri-list", "text/plain" }) do
		local output = Command("wl-paste"):arg({ "--no-newline", "--type", t }):output()
		if output and output.status.success then
			return output.stdout or "", nil
		end
	end
	-- ponytail: on failure we can't tell "clipboard empty" from "wl-paste missing";
	-- treat both as empty. The copy path already surfaces a missing binary.
	return "", nil
end

local function copy_or_cut(action)
	local urls = GET_TARGETS()
	if not urls or #urls == 0 then
		notify("warn", "No files to " .. action)
		return
	end

	local norm = {}
	for _, u in ipairs(urls) do
		local p = normalize_path(u)
		if p and p ~= "" then
			norm[#norm + 1] = p
		end
	end
	if #norm == 0 then
		notify("warn", "No valid path")
		return
	end

	write_mode(action == "cut" and "cut" or "copy")
	local ok, err = wl_copy(norm)
	if not ok then
		notify("error", "wl-copy failed: " .. tostring(err), 3)
		return
	end

	notify(nil, (action == "cut") and "Path cut to clipboard" or "Path copied to clipboard")
end

local function paste()
	-- The keymap runs native `paste` before this plugin, so an in-yazi yank is
	-- already handled; we only cover the "nothing yanked -> pull from the system
	-- clipboard" case.
	if HAS_YANKED() then
		return
	end

	local content, perr = wl_paste()
	content = content and content:gsub("\n+$", "") or ""
	if perr then
		notify("error", "wl-paste failed: " .. tostring(perr), 3)
		return
	end
	if content == "" then
		notify("warn", "Nothing to paste")
		return
	end

	local srcs = {}
	for line in (content .. "\n"):gmatch("(.-)\r?\n") do
		if line:sub(1, 1) ~= "#" then -- skip text/uri-list comment lines
			local p = normalize_path(line)
			if p and p ~= "" then
				srcs[#srcs + 1] = p
			end
		end
	end
	if #srcs == 0 then
		notify("warn", "Nothing to paste")
		return
	end

	-- ponytail: pastes originating from a GUI file manager are always treated as
	-- copy; their cut markers are per-manager (x-kde-cutselection,
	-- x-special/nautilus-clipboard, ...). Add per-manager probes only if it bites.
	local mode = read_mode()
	local dest = normalize_path(CURRENT_CWD())
	local cmd = (mode == "cut") and "mv" or "cp"

	local argv = {}
	if cmd == "cp" then
		argv[#argv + 1] = "-a"
	end
	argv[#argv + 1] = "--"
	for _, src in ipairs(srcs) do
		argv[#argv + 1] = src
	end
	argv[#argv + 1] = dest

	local out, err = Command(cmd):arg(argv):output()
	if not out then
		notify("error", cmd .. " failed: " .. tostring(err), 4)
		return
	end

	local success = out.status.success
	if not success and mode == "cut" then
		-- mv can partially succeed; accept only if every destination now exists
		-- (a bogus/missing source leaves no destination -> real failure).
		local dd = (dest or ""):gsub("/+$", "")
		success = true
		for _, src in ipairs(srcs) do
			local name = basename(src)
			if not (name and fs.metadata(Url(dd .. "/" .. name))) then
				success = false; break
			end
		end
	end

	if not success then
		local msg = (out.stderr and out.stderr:gsub("\n+$", "") or "unknown")
		notify("error", cmd .. " failed: " .. msg, 4)
		return
	end

	if mode == "cut" then
		local new_paths = {}
		local dest_dir = (dest or ""):gsub("/+$", "")
		for _, src in ipairs(srcs) do
			local name = basename(src)
			if name and name ~= "" then
				new_paths[#new_paths + 1] = dest_dir .. "/" .. name
			end
		end
		if #new_paths > 0 then
			wl_copy(new_paths)
			write_mode("cut")
		else
			clear_state()
		end
	end

	notify("info", (cmd == "mv") and "Moved" or "Copied")
end

local function setup(_, _)
end

local entry = function(_, job)
	local args = job and job.args or {}
	local action = args[1] or args.action or args.args or "copy"

	if action == "copy" or action == "cut" then
		copy_or_cut(action)
	elseif action == "paste" then
		paste()
	else
		notify("error", "Unknown action: " .. tostring(action), 2)
	end
end

return { entry = entry, setup = setup }
