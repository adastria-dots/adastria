local B = require("utils.bootstrap")
local L = require("utils.layout")

local monitors = {{ "eDP-1", "preferred", "0x0" }}

B.setup_displays(monitors)

L.register(2)

hl.config({ input = { scroll_method = "no_scroll" } })

B.auto_start({ 
	"fcitx5",
	"keqing-shell"
 })
