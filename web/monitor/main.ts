// The monitor (/monitor): every call's timeline, live. The calls on the left, the selected
// call in the middle, its cost, note and memory changes on the right. "Follow live" opens a
// call as soon as it starts and keeps its newest turn in sight.

import { $ } from "../shared/html.ts";
import { withDev } from "../shared/api.ts";
import { initList } from "./list.ts";
import { initDetail } from "./detail.ts";
import { select, startFeed } from "./feed.ts";

const follow = $<HTMLInputElement>("follow");
$<HTMLAnchorElement>("navPhone").href = withDev("/");

initList({ onSelect: id => { follow.checked = false; void select(id); } });
initDetail({ following: () => follow.checked });
startFeed({ following: () => follow.checked, stopFollowing: () => { follow.checked = false; } });
