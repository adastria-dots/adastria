-- TILING (native workspace/window management)

local WPM = 10

local Tiling = {}

local TMP = "special:__tmp_swp"

local function active_ws_id()
	local ws = hl.get_active_workspace()
	return ws and ws.id
end

-- Resolve a local (1..WPM) workspace number to its global id on the active monitor's group.
-- Raw global ids, special workspaces, and out-of-range values pass through unchanged.
local function resolve(id, global)
	if global then return id end

	local n = tonumber(id)
	if not n or n < 1 or n > WPM then return id end

	local active = active_ws_id() or 1
	local base = math.floor((active - 1) / WPM) * WPM
	return base + n
end

local function move_all(windows, workspace)
	for _, w in ipairs(windows) do
		hl.dispatch(hl.dsp.window.move({ window = "address:" .. w.address, workspace = workspace, follow = false }))
	end
end

-- Switch focus to target local workspace.
function Tiling.fw(id, opts)
	opts = opts or {}
	hl.dispatch(hl.dsp.focus({ workspace = resolve(id, opts.global) }))
end

-- Move the active window to target local workspace.
function Tiling.mw(id, opts)
	opts = opts or {}
	local window = opts.address and ("address:" .. opts.address) or "activewindow"
	hl.dispatch(hl.dsp.window.move({
		window = window,
		workspace = resolve(id, opts.global),
		follow = opts.follow ~= false,
	}))
end

-- Close all windows in scope: nil = active workspace, "a" = every workspace, number = that raw global workspace.
function Tiling.cw(scope)
	local windows
	if scope == "a" then windows = hl.get_windows({})
	elseif scope then windows = hl.get_workspace_windows(scope)
	else
		local ws = active_ws_id()
		windows = ws and hl.get_workspace_windows(ws) or {}
	end

	for _, w in ipairs(windows) do
		hl.dispatch(hl.dsp.window.close({ window = "address:" .. w.address }))
	end

	if scope == "a" then Tiling.fw(1) end
end

-- Move every window from the active workspace into the target workspace, then follow.
function Tiling.mi(id, opts)
	opts = opts or {}
	local dst = resolve(id, opts.global)
	local src = active_ws_id()
	if not src or src == dst then return end

	move_all(hl.get_workspace_windows(src), dst)
	Tiling.fw(id, opts)
end

-- Swap every window between the active workspace and the target workspace.
function Tiling.sw(id, opts)
	opts = opts or {}
	local dst = resolve(id, opts.global)
	local src = active_ws_id()
	if not src or src == dst then return end

	local src_windows = hl.get_workspace_windows(src)
	local dst_windows = hl.get_workspace_windows(dst)
	if #src_windows == 0 and #dst_windows == 0 then return end

	move_all(src_windows, TMP)
	move_all(dst_windows, src)
	move_all(src_windows, dst)

	Tiling.fw(id, opts)
end

local function adjacent_monitor(mon, dir)
	local mx, my = mon.x + mon.width / 2, mon.y + mon.height / 2
	local best, best_d
	for _, m in ipairs(hl.get_monitors()) do
		if m.name ~= mon.name then
			local dx, dy = (m.x + m.width / 2) - mx, (m.y + m.height / 2) - my
			local matches = (dir == "l" and dx < 0)
				or (dir == "r" and dx > 0)
				or (dir == "u" and dy < 0)
				or (dir == "d" and dy > 0)
			if matches then
				local d = dx * dx + dy * dy
				if not best_d or d < best_d then best, best_d = m, d end
			end
		end
	end
	return best
end

-- Move the active window in a direction, falling back to the adjacent monitor if it can't move further.
function Tiling.adaptive_move(dir)
	local win = hl.get_active_window()
	if not win or not win.monitor or not win.workspace then
		hl.dispatch(hl.dsp.window.move({ direction = dir }))
		return
	end

	local axis = (dir == "l" or dir == "r") and "x" or "y"
	local ws_id, mon = win.workspace.id, win.monitor
	local before = {}
	for _, w in ipairs(hl.get_workspace_windows(ws_id)) do before[w.address] = w.at[axis] end

	hl.dispatch(hl.dsp.window.move({ direction = dir }))

	local moved = false
	for _, w in ipairs(hl.get_workspace_windows(ws_id)) do
		if before[w.address] ~= w.at[axis] then
			moved = true
			break
		end
	end
	if moved then return end

	local target = adjacent_monitor(mon, dir)
	if target then hl.dispatch(hl.dsp.window.move({ monitor = target.name })) end
end

return Tiling
