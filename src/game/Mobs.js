// Wildlife, and the one thing on the planet that wants you dead. Mobs live in
// cubesphere cell space like the player, so they walk upright anywhere on the
// surface.
//
// Presentation is entirely GLB: each species is a Kenney model carrying its own
// animation clips, and this file picks which clip to play. It used to build
// every animal out of boxes and swing four leg pivots by hand — a good gait,
// but each new species meant a new build function, and the models come with
// better motion than the code did.
//
// Motion is continuous: heading is steered at a limited turn rate, speed is
// accelerated toward a target, and step-ups are visually smoothed so animals
// never pop between cell heights. See the notes in update() for the teleport
// bugs this replaced.

import * as THREE from 'three';
import { F, D, GRAVITY, R_SEA, R_MIN, BIOME, cidx } from '../world/Constants.js';
import {
  cellToWorld, tangentFrame, normalizeCell, colParts, colNeighbor, stepColumn,
} from '../world/Sphere.js';
import {
  ID, IS_SHAPED, IS_LEAF, IS_TREE, IS_SOLID, collisionBoxes, LIGHT_EMIT, RENDER_TYPE, R_LIQUID,
  isPassable, CONTACT_HURT,
} from '../world/Blocks.js';
import { itemIdOf } from './Items.js';
import { rollStock, rollRequest } from './Trade.js';
import { makeRng, clamp, lerp } from '../util/Noise.js';
import * as MobModels from './MobModels.js';

/**
 * Bodies alive at once, anywhere.
 *
 * This was 26 for a whole planet, and a player who walked in a straight line
 * reported meeting almost nothing — rightly. 26 is a headcount over a disc of
 * DESPAWN_RADIUS (110 units, ~38,000 square units of ground), i.e. one animal
 * per 1,500 units of terrain, and a third of those slots go to husks, fish and
 * whatever the player has already walked past but not yet outrun. What is left
 * is a meadow with four cows in it.
 *
 * 64 was the next attempt and it was still reported thin, for a reason a single
 * headcount hides: it is a *global* ceiling, and the populations under it were
 * not sharing it evenly. This is a sum of budgets now rather than one dial —
 * 62 land, 18 aquatic, 14 flying, 8 husks, one merchant, plus a little headroom
 * — so raising one population can never be the thing that quietly starves
 * another. 62 land bodies is about one per 600 square units, roughly
 * twenty-four units between neighbours.
 *
 * The cost this buys is bounded and known. There is no per-frame O(n²) in this
 * file any more: _separate was the last one and is a hash-grid lookup now, and
 * it is the one number here that has been measured rather than reasoned about.
 * Over synthetic herds on a sphere, driving the real function:
 *
 *   bodies      60     120     134     200     400     800
 *   all-pairs   52us   210us   251us   596us  2619us 10740us
 *   hash grid    9us    32us    27us    53us   204us   642us
 *
 * That is a flat 41.5ns per pair before and roughly 150-500ns per *body* after,
 * so the headcount no longer prices itself quadratically and this ceiling is no
 * longer the thing _separate is protecting. What costs real work is still
 * _nudge (three footprint tests, nine column samples each) and that fires only
 * on genuine overlaps, so it scales with how crowded one spot is rather than
 * with the headcount. The prey search is still one pass per hungry carnivore
 * per PREY_PERIOD.
 *
 * What decides this ceiling now is the per-body linear cost, and the mixer
 * update in _animate is the bulk of it. Raising the cap is an _animate
 * question, not a _separate one.
 *
 * A frame-time sample taken with hostiles abroad used to be worthless for a
 * reason that had nothing to do with the headcount: `_pathBearing` re-ran a
 * full-budget A* every frame for any husk that could not reach the player, and
 * that was 61.6% of the whole mob tick on a measured savage night. It is fixed
 * and bounded now (see PATH_PER_FRAME), so the numbers below can be trusted
 * again with the lights out.
 */
/*
 * The budgets below sum to more than this, and that is fine. Measured, because
 * the arithmetic says otherwise and the arithmetic is misleading.
 *
 * 84 land + 18 aquatic + 18 flying + 18 surface husks (a savage world) + 4 cave
 * husks + 3 monsters + 1 merchant is 146 against a ceiling of 134, which reads
 * as an over-subscription that would starve whatever spawns last — husks,
 * monsters and the merchant, in that order. It is not one, because the two
 * halves cannot be full at the same time: the surface husk budget only opens at
 * night, and night is exactly when `_bedDown` takes the land and flier budgets
 * down to NIGHT_WILDLIFE of themselves.
 *
 * Driven from the sun direction the spawner actually reads, five minutes of
 * each clock with the first ninety seconds thrown away while the population
 * walks from one budget to the other:
 *
 *   day    84 land, 18 water, 18 air,  0 husks, 3 monsters, 1 trader = 124
 *   night  34 land, 18 water,  7 air,  8 husks, 3 monsters, 1 trader =  71
 *
 * So the true peak is the daytime 124, ten under this ceiling, and the sum of
 * 146 is a number no clock can produce. If a budget is ever raised, check the
 * *day* line — that is the one with the headroom left in it, and there is not
 * much of it.
 *
 * --- and why these are the numbers they are, which is a report --------------
 *
 * "There are so many animals like omg they are so much", and then the
 * correction that made sense of it: "the density of animals was never the
 * problem it was just them not being spread around the whole planet, they are
 * mostly near spawn area."
 *
 * The first report was answered by cutting these budgets roughly in half. That
 * was wrong, and the way it was wrong is worth keeping: a headcount cannot
 * answer either report, because what a player meets is not the roster, it is
 * how many bodies are inside the ground they can see — and THAT was not being
 * set by the budget at all. It was being set by where the spawner put things.
 * See spawnDist: the placement had a 32.7x density gradient falling away from
 * the player, so every player stood in a small dense cloud with an empty world
 * around it. Cutting the budget shrank the cloud and the empty world together
 * and moved the gradient not at all.
 *
 * One census a second over four minutes, daylight, same planet and same seed,
 * player standing still at the world spawn:
 *
 *                                     live   within 20u        40u      80u
 *   46/12/12, 1/r placement (the cut)  71.5   8.85     24.23 (peak 37)  54.78
 *   84/18/18, even over area (now)    120.1   4.30     13.85 (peak 17)  54.22
 *
 * The roster is up 68% and the crowd inside forty units is down 43%, its peak
 * from 37 to 17. That is the whole case for reverting the cut: the crowding
 * and the emptiness were one bug, and fixing it pays for the animals twice
 * over. And the same run walking rather than standing, which is the half the
 * cut could never have helped:
 *
 *                                     live   within 20u        40u      80u
 *   46/12/12, 1/r placement, walking   73.8   2.35     10.20            32.80
 *   84/18/18, even over area, walking 121.8   3.67     13.44            47.92
 *
 * Standing used to find 2.4x as many animals inside forty units as walking
 * did. It is 1.03x now. A base that felt busy and a road that felt dead were
 * the same population seen from the inside and from the outside of it.
 *
 * The population is a disc that travels with the player, and that is correct
 * and deliberate — "we are rendering the planet by chunks obviously not all
 * animals will render". Nothing exists past DESPAWN_RADIUS and nothing should.
 * The three things that could have made a travelling disc read as "crowded at
 * spawn, empty everywhere else" were checked one at a time, because the
 * obvious suspect was not the culprit:
 *
 *   - Does the despawn ring actually fire? Yes. Over eight minutes of standing
 *     and walking, the furthest body from the player ever recorded was 145.0
 *     units against a DESPAWN_RADIUS of 145. Nothing lingers behind.
 *   - Do bodies the player has left behind hold the global cap open? No. A
 *     sweep of all 5,046 regions of the planet finds every living body inside
 *     the disc and none outside it, at every sample. There is no leak, so the
 *     cap is never spent on animals nobody is near.
 *   - Does travelling get refilled to the same population as standing? THIS
 *     was the one that failed, and it failed at 42%: 10.20 bodies inside forty
 *     units while walking against 24.23 while standing. Not because the refill
 *     was too slow — the roster was full the whole time — but because of where
 *     the refill was PUT. See spawnDist. It is 97% now.
 *
 * So the fix is not persistence and not a bigger cap; it is that the disc the
 * player carries is now the same density everywhere in itself.
 *
 * The one place the disc is still not flat is the twenty units the spawner is
 * forbidden to place in (SPAWN_MIN_DIST). Bodies wander in and nothing removes
 * them there, so it fills from the ring: measured, its density climbs from
 * 2.39 to 5.57 per 1000 square units over seven minutes of a player standing
 * in one spot, against a served ring that holds 2.2-2.7 throughout. A 2.1x
 * peak that takes seven minutes to build, where it used to be 125x and took
 * ten seconds.
 *
 * --- what a body costs, measured, and why 134 is affordable ------------------
 *
 * Measured headless on the real planet, driving the real Mobs.update over real
 * generated terrain with the real GLB rigs and mixers, three minutes a run with
 * nothing else on the machine. Per-frame percentiles, never whole-block timing:
 * process.cpuUsage() has 15ms granularity on Windows and would quantise a 1ms
 * tick into noise. p05 is the clean-frame cost, p50 the clean-frame cost plus
 * its share of a scavenge.
 *
 *                       bodies   p05     p50     p90     p95     p99     max
 *   46/12/12/90  (cut)    72.3  0.473   0.699   2.345   4.269  27.107   84.3
 *   84/18/18/134 (now)   122.5  0.823   1.329   5.651  18.894  93.218  349.8
 *
 * The marginal cost of the fifty bodies restored is 7.0us each on a clean
 * frame and 12.5us each at the median — so the day peak of 124 is 0.82ms of
 * clean frame. The clean-frame figure confirms the 7.4us this comment has
 * claimed for a long time; the median figure is higher because the garbage
 * scales with the headcount too, and the p95 and p99 columns are that garbage
 * and nothing else.
 *
 * Attributed properly, by trimming the list to a fixed size EVERY frame rather
 * than emptying it once. Emptying it once measures nothing, because the
 * spawner refills it inside a few seconds — the first attempt at this table did
 * exactly that and reported that 91% of the tick was fixed overhead, which its
 * control refused to accept:
 *
 *   bodies held    122     61      0
 *   tick p50    1.5193 0.5275 0.0001 ms
 *
 * So the fixed overhead of a tick with no bodies in it is a tenth of a
 * microsecond: this tick is the bodies, all of it, and a per-body number is
 * the honest way to price it. The slope is mildly superlinear — the upper half
 * of the population costs 1.9x what the lower half does per body — which is
 * the separation grid and the prey searches finding more to look at, not a
 * return of any O(n^2).
 *
 * Heap, after a forced collection so this is what the bodies HOLD rather than
 * what they were making:
 *
 *   bodies held    122     61      0
 *   heap        35.41  30.62  24.50 MB
 *
 * 87.4 KB a body, so a full ring is 10.9MB and restoring these caps costs
 * about 4.4MB over the cut ones. That is the number the mobile target has to
 * carry, and it is a rig clone per body rather than anything this file
 * allocates per frame.
 *
 * If this is ever raised again, it is not the dial to raise: the day line is
 * made of MAX_WILDLIFE, MAX_AQUATIC and MAX_FLYING, and this is only the
 * ceiling they are checked against.
 */
const MAX_MOBS = 134;
/**
 * Of that, how many may be ordinary land animals. Kept as its own budget rather
 * than a fraction of MAX_MOBS for the same reason the two husk caps are
 * separate: a shared ceiling lets one population starve another. The old
 * top-up gate was `list.length < MAX_MOBS * 0.7`, which counted husks, fish and
 * the merchant — so a busy night quietly stopped the wildlife from backfilling
 * at all.
 *
 * This was cut to 46 on the report "damn there are so many animals like omg
 * they are so much", and put back because that read the report wrong. The
 * correction, verbatim: "the density of animals was never the problem it was
 * just them not being spread around the whole planet, they are mostly near
 * spawn area."
 *
 * They were. Not because the spawner is anchored to the world origin — it has
 * always searched from the player's own column — but because the search put
 * 37% of what it placed in the 20-40 unit band and 4.2% in the 100-120 one,
 * which per unit of ground is a 32.7x gradient falling away from the player.
 * See spawnDist. A player is therefore always standing in the dense middle of
 * a small cloud, and everything else is the thin outside of it, and the two
 * halves of that are the two halves of the report.
 *
 * Both numbers below are one census a second over four minutes, on the real
 * planet with the real spawner, in daylight, same world and same seed:
 *
 *                                  live   within 20u        40u          80u
 *   46 land, old placement, standing 71.5  8.85       24.23 (peak 37)   54.78
 *   84 land, even placement,standing 120.1 4.30       13.85 (peak 17)   54.22
 *   46 land, old placement, walking  73.8  2.35       10.20            32.80
 *   84 land, even placement,walking  121.8 3.67       13.44            47.92
 *
 * So this went UP by 83% and the crowd a standing player is inside went DOWN
 * by 43%, its peak from 37 to 17. That is the whole argument for the number:
 * spreading the same population over the ground it was always allowed to use
 * buys back more than doubling it costs. The cut was solving the crowding by
 * deleting animals; this solves it by putting them where the rules already
 * said they could go, and can afford more of them for doing so.
 *
 * The other half of the correction is the walking line, which is what "spread
 * around the whole planet" actually asks for. Standing used to find 2.4 times
 * as many animals inside forty units as walking did — a base that feels busy
 * and a road that feels dead, from one population. It is 1.03 times now:
 * 13.85 standing against 13.44 walking, which is the same world wherever you
 * are in it.
 *
 * The floor on this is not comfort, it is that a meadow has to have cows in
 * it, and the ceiling is that a meadow is not a stockyard. Do not move it
 * without re-running that census — the number to read is the forty-unit
 * column, not this one, because this one is a headcount over 45,000 square
 * units and what a player meets is the 5,000 in front of them.
 */
const MAX_WILDLIFE = 84;
/**
 * The two populations that were still inside the land budget, which is the very
 * failure the comment above describes, happening one level further down.
 *
 * Fish were counted as wildlife, and the land top-up runs first in the tick. So
 * on any tick with room for a fish there was also room for a cow, the cows were
 * placed first, and the fish line was reached with the budget already spent. On
 * the ticks that did get past it, it was gated behind a coin flip and placed at
 * most one body — one fish, somewhere inside a hundred and ten units of ocean.
 * A lake with nothing in it was not bad luck, it was the arithmetic.
 *
 * Bees were the same story with a second squeeze on top: a bee is one entry in
 * a biome list of up to twelve, so it had to win the land budget and then win a
 * one-in-twelve draw for the slot. Both now come off their own budget in their
 * own pass, and the biome tables go back to being the record of which biomes
 * have bees in them rather than the thing rationing them.
 *
 * Cut to 12 with the density cut and restored with it, for the reason on
 * MAX_WILDLIFE: the crowding was placement, not headcount. These two matter
 * more to the spread than their size suggests, because fish and bees arrive in
 * groups (see SHOAL_MIN and DRIFT_MIN) and what a player meets is whether the
 * water in front of them has a shoal in it, not how many fish the planet holds.
 * _findWaterColumn draws its distance evenly over AREA now as well, so a lake
 * at the far edge of the ring is as likely to be stocked as one at the near
 * edge; it was getting a fraction of the shoals for no reason but arithmetic.
 */
const MAX_AQUATIC = 18;
/**
 * Raised from 14 when the parrot started flying rather than hopping. The two
 * fliers now share this budget, and leaving it alone would have bought parrots
 * by taking bees away — which is the exact trade the paragraph above is about,
 * one level further down again.
 *
 * Cut to 12 with the density cut and restored with it, on the aquatic budget's
 * terms: fliers arrive as drifts too, and a bee you can hear is worth more than
 * a bee you can count. The parrot's share of it is protected by the biome
 * tables (see FOREST), not by this number. _spawnDrift places through
 * _findSpawnColumn, so it picked up the even-over-area draw with the land
 * animals and did not need its own change.
 */
const MAX_FLYING = 18;
/** Wildlife spawned per top-up tick, and how often a tick comes round.
 *
 * A player walks 4.4 units a second and sprints at 6.8, so the ring of terrain
 * around them turns over completely in well under a minute. One animal every
 * six seconds cannot refill that — the herd stayed behind at the world spawn
 * and the road ahead was empty, which is exactly what was reported. Six every
 * two seconds refills the ring faster than sprinting empties it, and does
 * nothing at all once the budget is full. */
const SPAWN_PERIOD = 2.0;
const SPAWN_PER_TICK = 6;
/**
 * Fish and bees arrive in groups, not one at a time, and that is not decoration
 * — it is what the report is about. Eighteen fish scattered evenly over every
 * body of water inside the despawn ring is still an empty-looking lake, because
 * you are only ever looking at a fraction of that water. The same eighteen in
 * four shoals means the water you *are* looking at either has a shoal in it or
 * does not, and a shoal reads as populated the moment you see one.
 */
const SHOAL_MIN = 3;
const SHOAL_SPAN = 4;         // so 3..6 fish per placed shoal
const SHOAL_SPREAD = 3;       // columns either way the rest of the shoal sits
const FISH_PER_TICK = 8;      // ceiling on bodies one tick may add
const DRIFT_MIN = 2;
const DRIFT_SPAN = 3;         // 2..4 bees per placed drift
const DRIFT_SPREAD = 2;
const FLIER_PER_TICK = 6;
// Hostiles are capped well below the herd: a night should be tense, not a
// siege. The cap is per habitat rather than global, and deliberately so — a
// single shared budget let one habitat starve the other, and a combined ceiling
// would bring that straight back. The two populations are never in the same
// place anyway, which is the whole reason they need separate budgets.
//
// Raised from 5 and 3 alongside the husk speed drop below, and the two changes
// only make sense together: a husk that can no longer run you down has to
// arrive in numbers or it stops being a threat at all. More of them, each one
// individually escapable, is a night you can walk home through if you keep
// moving — and cannot stand still in.
const MAX_HOSTILE_SURFACE = 8;
/**
 * ...and what the dark is worth on a savage world.
 *
 * Only the *surface* budget moves, and that is the whole of the arithmetic.
 * Read the day and night lines on MAX_MOBS: the true peak is the daytime 124 of
 * 134, ten under the ceiling, and the ten are the only headroom there is. The
 * surface husk budget is the one population that cannot touch that line,
 * because it opens at sunset and sunset is exactly when `_bedDown` takes the
 * land and flier budgets down to NIGHT_WILDLIFE. Re-measured against the
 * restored wildlife budgets, five minutes of each clock:
 *
 *   day    84 land, 18 water, 18 air,  0 husks, 3 monsters, 1 trader = 124
 *   night  34 land, 18 water,  7 air,  8 husks, 3 monsters, 1 trader =  71
 *   night, savage, this number       14 husks                        =  77
 *
 * So the peak roster is the day's 124 whatever this is set to, and no other
 * population loses a slot: the wildlife budgets are separate numbers and the
 * husks have never been able to spend them. Fifty seven under the ceiling at
 * night is a lot of room, and it is room this may have — but it is not room
 * the *day* line has, which is the line to check before raising anything.
 *
 * Rejected: raising MAX_HOSTILE_CAVE with it. Cave husks spawn at any hour, so
 * every one of them lands on the *day* line, which is the one with six left in
 * it. Rejected: raising MAX_MONSTERS, for the same reason and more so — a
 * monster does not care about the sun at all, and "more at night" is not what a
 * bigger monster cap buys.
 *
 * Fourteen rather than something larger because the shape of a night has to
 * survive: eight was chosen so a night is tense rather than a siege, and each
 * husk is individually escapable at 4.5 against a walk of 4.4. Fourteen is
 * still a night you can walk home through if you keep moving, at nearly twice
 * the pressure, against a player whose next mistake is their last.
 */
const MAX_HOSTILE_SAVAGE = 14;
/**
 * How many monsters may be abroad at once, and how often one is tried.
 *
 * The cap is the thing that makes them rare in the sense that matters: not
 * how often you see one, but how many can be on you at a time. Three across
 * the whole planet means meeting one is an event and meeting two is bad luck.
 * The roll is per spawn tick, the same tick the wildlife top-up runs on.
 */
const MAX_MONSTERS = 3;
const MONSTER_CHANCE = 0.05;
const MAX_HOSTILE_CAVE = 4;
/**
 * How far a placed light keeps husks out, in columns and layers. Eight columns
 * is a little short of a torch's actual glow, deliberately: a corridor you have
 * lit should be safe, but a single torch at a cave mouth should not sterilise
 * the chamber behind it.
 */
const LIGHT_GUARD = 7;
const LIGHT_GUARD_K = 3;

// The cave search has its own geometry. Underground, cover comes from rock
// rather than distance, so it looks close and accepts close — a husk around the
// next bend is the whole point of a cave.
const CAVE_WALK_MIN = 6;
const CAVE_WALK_SPAN = 18;
const CAVE_MIN_DIST = 10;

/** How long a blocked hunter commits to one way round an obstacle, and how far
 * off its target bearing it leans while doing so. */
const WALL_SLIDE_TIME = 1.4;
const WALL_SLIDE_TURN = 1.15;

/**
 * Headings a stuck hunter tries, as turns either side of the bearing to its
 * target. Ordered outward so the straightest workable line wins, and stopping
 * short of a right angle on purpose — a mob that will turn 135 degrees to
 * approach walks backwards away from you, which reads as broken rather than
 * clever.
 */
const PROBE_ANGLES = [0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.55, -1.55];

// --- falling, and the two things that kill an animal with nobody swinging ----
/**
 * Blocks of fall an animal walks away from, and half-hearts per block past it.
 *
 * Deliberately the player's own ladder (FALL_FREE 3.0, one per block) rather
 * than a table of its own. You learn what a drop costs by taking one, and an
 * animal that survives what would have killed you reads as scenery rather than
 * as something living on the same planet.
 *
 * It bites hardest at the small end, which is the point: a bunny has 4hp, so
 * seven blocks finish it; a cow needs thirteen and an elephant twenty-three,
 * which is more than the twenty-four layers of terrain above sea will usually
 * offer in one clean drop. Small things go over the edge and do not come back,
 * big things are hard to shift and hard to kill by shifting them — the same
 * shape as the knockback ladder below, and for the same reason.
 */
const MOB_FALL_FREE = 3;
const MOB_FALL_PER_BLOCK = 1;
/**
 * The tallest drop an animal will *choose* to step off, in layers.
 *
 * This was 4 in the footprint test and 3 in the route search, so there was a
 * one-layer window where a mob would happily walk off something its own
 * pathfinder had refused. Both are MOB_FALL_FREE now and the rule is one
 * sentence: nothing walks off a drop that would cost it health. Being knocked
 * off one, or having the ground mined out from under it, is a different matter
 * entirely — see the tumble in update().
 */
const MOB_STEP_DOWN = MOB_FALL_FREE;
/**
 * The furthest the floor clamp will lift a body in one frame, in layers.
 *
 * A per-frame cap and not a rate, which looks like a bug and is not: it is
 * there to break the escalators described on _groundUnder, and an escalator is
 * counted in frames. One block plus slack, because a slab or a stair tread
 * tops out at k + 0.5 and a genuine step onto one has to stay legal.
 *
 * Shared by both floor branches in update(). The swimming/flying one used to
 * set the height outright with no cap at all — see the note there.
 */
const MOB_MAX_RISE = 1.05;

// --- flight ------------------------------------------------------------------
/**
 * How far below a flying body lava still counts as a wall, in layers.
 *
 * A flier gets a body-occupancy collision now (see the flier branch in
 * _footprintCost) rather than the walker's bed-relative rules, and the rule it
 * loses along with the rest is the one that read `lava at gk + 1` — the only
 * thing that had been keeping a bee out of a lava lake, since a lake is not
 * solid and so is not an obstacle to a body that flies. Four layers keeps every
 * low hoverer out of one (bat 1.2, parrot's bee-sized cousin 1.5, ghost 1.8,
 * cthulhu 2.0, dragon 2.4) and lets a parrot at 6.0 cross a flow that cannot
 * reach it, which is what a bird would do.
 */
const FLY_LAVA_CLEAR = 4;
/**
 * How far ahead a flier looks for something to climb over, in cells, and how
 * much air it wants above whatever it finds.
 *
 * Real collision for fliers is only half a fix. The other half is that a bird
 * which merely *stops* at the treeline is worse than one that flew through it:
 * "a parrot that will not fly through a wood is not a parrot". A flier holds
 * `hover` above the ground under its own footprint, and by the time a trunk or
 * a canopy is under that footprint the body is already in it — the height seek
 * has no warning at all. So it is given some: two probes along the heading,
 * and the hover target is raised to clear the tallest thing they find.
 *
 * 1.4 and 2.9 cells against the fastest flier's 6.3 cells/s is a fifth to
 * half a second of warning, and the climb rate is 2.2 cells/s — which is not
 * enough to top a pine in one go and does not need to be. What it buys is that
 * the bird is already rising when the horizontal move is refused, so the veer
 * and the climb compose into a body going up and around rather than into a body
 * pressed against bark. Measured over a forest: see the flier table in the
 * commit note — cells/s covered is unchanged and time inside terrain is not.
 *
 * The clearance is `tall` plus this, not a flat number, because a dragon and a
 * bee do not need the same room over a treetop.
 */
/**
 * How often a body re-asks what is over its head, in seconds, and how dark a
 * fully roofed one gets.
 *
 * 0.6 s because walking under a tree is not a per-frame event and the probe
 * walks a column; jittered at the call site so a herd does not all sample on
 * the same frame. 0.55 because a mob indoors should read as indoors without
 * becoming a silhouette - the terrain around it keeps its own baked light, and
 * the two have to look like they are in the same room.
 */
const SKY_PROBE_PERIOD = 0.6;
const SKY_SHADE_MIN = 0.55;

const FLY_LOOK_NEAR = 1.4;
const FLY_LOOK_FAR = 2.9;
const FLY_CLEAR = 0.6;

// --- climbing (the monkey, and nothing else) ---------------------------------
/** How far above itself a climber will look for a canopy worth going to. */
const CLIMB_REACH = 12;
/** Layers per second up or down. Slower than a fall, faster than a walk. */
const CLIMB_SPEED = 2.2;
/** Seconds a monkey sits up there before coming back down. */
const PERCH_MIN = 6;
const PERCH_MAX = 16;
/** Seconds between a climber asking itself whether to go up. */
const CLIMB_PERIOD = 2.5;
/** And the chance it says yes when it is beside a tree and free to. */
const CLIMB_CHANCE = 0.5;
/** And how long it will not consider climbing again after coming down. */
const CLIMB_REST = 20;
/** Seconds of getting nowhere before a climb is written off. */
const CLIMB_STALL = 3;
/**
 * Seconds of fall immunity after a climb ends off the ground.
 *
 * A grace rather than a fix, and worth being plain about: about one climb in
 * nine ended with the monkey losing its grip and dropping, for one or two
 * damage, and the cause was not the descent target — correcting that changed
 * the rate not at all. What is defensible on its own terms is the rule this
 * enforces: an animal that lives in trees does not injure itself getting out of
 * one. It falls, it just does not get hurt doing it.
 */
const CLIMB_GRACE = 4;
/**
 * Standing in lava, in half-hearts, and how often the toll is taken.
 *
 * Charged in instalments rather than per frame because every hit is a cry:
 * `_damage` calls onSound, and a per-frame drain turns one animal falling in a
 * lava lake into sixty overlapping death rattles a second. Half a second is
 * short enough that nothing wades through a pool and out the other side —
 * three half-hearts a tick kills a bunny in one, a cow in under two seconds
 * and an elephant in a little over three.
 */
const LAVA_DPS = 6;
const LAVA_PERIOD = 0.5;
/**
 * Still alight after climbing out, in seconds, and the toll while it lasts.
 *
 * The player's numbers, deliberately, and they are main.js's `_tickFire`: five
 * seconds relit every frame the body is in the lava, one half-heart every 0.9s
 * once it is out, and water puts it out at once. Measured before this existed:
 * a player who touched lava lost 3 per 0.45s in it and another 5 over the five
 * seconds after, while a mob lost 3 per 0.5s in it and nothing at all after —
 * so a cow shoved into a pool and pulled straight out again walked away
 * completely unhurt from the thing that was still killing the player. Fire that
 * knows who the player is, the same complaint the spines already answered.
 *
 * Not `burnT`. That is the *daylight* clock — it counts up to BURN_SECONDS and
 * then kills the husk — so lighting a husk from lava through the same field
 * would burn it to death in 3.4s of shade. Two causes, two clocks.
 */
const LAVA_BURN_SECONDS = 5;
const LAVA_BURN_PERIOD = 0.9;
const LAVA_BURN_TOLL = 1;
/**
 * How often a body pressed against something spiky takes a point, in seconds.
 *
 * The player's cadence, deliberately — a cactus does not care what walked into
 * it. What differs is the reach: an animal is a cylinder of `mob.radius`, not a
 * player-sized box, so a cow brushes a cactus from further out than you do.
 */
const CONTACT_PERIOD = 0.5;
/**
 * How far past its own radius a body has to be for the spines to reach it.
 *
 * Bigger than the player's 0.015 because a mob is never resolved flush against
 * a wall the way the player's collision solver leaves it — the footprint test
 * refuses the move a whole cell earlier, so a body that has been *shoved* into
 * a cactus is the realistic case and it stops a little short.
 */
const CONTACT_TOUCH = 0.12;

// --- pathfinding -------------------------------------------------------------
/** Seconds between route searches for one hunting mob. */
const PATH_PERIOD = 0.9;
/** How long a route may be followed after the player has moved off its end. */
const PATH_MAX_AGE = 2.2;
/** Columns expanded before a search gives up, and the longest route it returns. */
const PATH_BUDGET = 2600;
const PATH_MAX_STEPS = 70;
/**
 * Route searches the whole planet may run in one frame.
 *
 * Measured on the real planet, headless, driving the real _findPath over real
 * generated terrain (ns timing, per-frame percentiles): a search that spends
 * its whole PATH_BUDGET costs 1.48ms at the median and 5.6ms at p95. That is
 * one body. Nothing used to bound how many bodies asked for one in the same
 * frame, and over a minute of a savage night with the spawner running and the
 * player walking, _findPath was 61.6% of the entire mob tick — p90 4.3ms per
 * frame, p95 5.8ms, p99 28.9ms, against a 16.7ms frame.
 *
 * Two, not one, because the cost of queueing is paid in how long a body that
 * has just seen the player walks at it in a straight line instead of round the
 * wall between them: a pack of fourteen acquiring on the same frame drains at
 * two a frame, so the last one waits seven frames (0.12s) rather than thirteen
 * (0.22s). Two is also what ESCAPE_PER_FRAME settled on, for the same reason.
 *
 * Deferring a search is cheap in a way that is worth being explicit about,
 * because it is what makes this safe: `_hunt` has already set `mob.want` to the
 * straight bearing at the player before `_pathBearing` is called, and a route
 * only ever *overrides* it. A body waiting for a search slot is walking at the
 * player, not standing still.
 */
const PATH_PER_FRAME = 2;
/** How far a body will step down without thinking of it as a fall. */
const PATH_MAX_DROP = MOB_STEP_DOWN;
/** How many waypoints ahead a mob steers. See _pathBearing. */
const PATH_LOOKAHEAD = 3;
const _pp = { f: 0, i: 0, j: 0 };
const _wp = { f: 0, i: 0, j: 0 };

/**
 * A binary min-heap keyed on score.
 *
 * A* wants the cheapest open node and nothing else, and a linear scan over an
 * open set that reaches into the hundreds is most of the search. Small enough
 * to keep here rather than pull in a dependency for.
 */
class Heap {
  constructor() { this.items = []; this.score = []; }
  get size() { return this.items.length; }
  push(item, score) {
    let n = this.items.length;
    this.items.push(item); this.score.push(score);
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (this.score[p] <= this.score[n]) break;
      this._swap(p, n); n = p;
    }
  }
  pop() {
    const top = this.items[0], last = this.items.length - 1;
    this.items[0] = this.items[last]; this.score[0] = this.score[last];
    this.items.pop(); this.score.pop();
    let n = 0;
    for (;;) {
      const l = n * 2 + 1, r = l + 1;
      let m = n;
      if (l < this.items.length && this.score[l] < this.score[m]) m = l;
      if (r < this.items.length && this.score[r] < this.score[m]) m = r;
      if (m === n) break;
      this._swap(m, n); n = m;
    }
    return top;
  }
  _swap(a, b) {
    const i = this.items[a]; this.items[a] = this.items[b]; this.items[b] = i;
    const s = this.score[a]; this.score[a] = this.score[b]; this.score[b] = s;
  }
}
/** How far past its own body a probe looks. */
const PROBE_AHEAD = 0.9;

/**
 * Seconds of chasing without closing any ground before a husk gives up.
 *
 * Written as an anti-stuck measure — a hunter clawing at the far side of a wall
 * — and it is now also the player's guaranteed way out. Nothing on the planet
 * chases faster than a sprint, so a sprinting player never lets a hunter improve
 * its best distance and the chase ends here after nine seconds. Nine is the
 * number that makes escaping cost roughly half the stamina bar at the 0.055/s
 * sprint drain, which is the point: you get away, but you spend something.
 */
const HUNT_STALL = 9;
/** And how long it then ignores the player, so it doesn't re-latch instantly. */
const HUNT_COOLDOWN = 14;
/** Seconds a husk survives in direct sun once it catches. */
const BURN_SECONDS = 3.4;
const SPAWN_MIN_DIST = 20;    // world units — never pop in under the player's nose
/**
 * How far out a body survives, in world units.
 *
 * This has to sit outside the horizon or animals vanish while you are looking
 * at them, and the horizon moved: it goes as sqrt(2*R*h), so enlarging the
 * planet from a sea-level radius of 130 to 290 pushed the furthest visible
 * terrain from ~79 units to ~132. 110 was comfortably over the old horizon and
 * is *inside* the new one — the number did not change but its meaning did.
 *
 * 145 buys back the margin. It is not free: the disc grows from 38,000 square
 * units to 66,000, so the same population is spread 1.7x thinner, which is why
 * the wildlife budget goes up with it rather than after it.
 */
const DESPAWN_RADIUS = 145;

/**
 * What is left of the herds after dark, as a fraction of the daytime budget.
 *
 * Animals bed down at night; the planet should not carry the same meadow at
 * midnight that it carried at noon, and a night that looks exactly like a day
 * with the lights off is what makes the husks feel like a spawner rather than
 * a change in the world. The number is a fraction rather than its own cap so
 * the daytime budgets stay the single place population is set.
 *
 * Not zero, and not close to it. Something has to move out there or the night
 * is empty rather than quiet, and the few that remain are what make a torchlit
 * walk worth taking.
 */
const NIGHT_WILDLIFE = 0.4;

/**
 * How far off a sleeping animal has to be before it is quietly retired, and how
 * many may go per spawn tick.
 *
 * Both exist to keep the thinning invisible. Culling on the cap alone would pop
 * animals out of existence in front of a player watching them, and doing the
 * whole surplus at once empties a field between two glances. Two a tick, only
 * beyond the distance at which a body is a moving dot, is a herd that has
 * wandered off to bed by the time you notice it has gone.
 */
const NIGHT_BED_DIST = 62;
const NIGHT_BED_PER_TICK = 2;

/**
 * The two numbers that turn "how far away, in world units" into "how many
 * steps of _walkOut", which is the only way a spawn search can travel.
 *
 * They exist because mixing the two units is what actually produced the
 * "everything is bunched around spawn" report, twice. Every spawn search is
 * written against a distance in world units — SPAWN_MIN_DIST, DESPAWN_RADIUS,
 * the `d > DESPAWN_RADIUS - 25` reject — and every one of them *travels* in
 * random-walk steps, with the step counts picked by hand. Nobody converted
 * between the two, so the placement rules said "anywhere from 20 to 85 units
 * out" while the walk that had to find those spots reached about 41 on a good
 * day. The far two thirds of the ring the rules allow was unreachable, and the
 * whole population piled into the near third — one animal per 85 square units,
 * four times the density the MAX_WILDLIFE comment is written against.
 *
 * CELL_SIZE comes off the planet rather than being written down, so the ring
 * keeps its size in metres when F and R_SEA move; that is the whole reason it
 * is derived. WALK_YIELD is the measured efficiency of _walkOut: it holds a
 * heading, but it veers, so a step of one cell nets about 0.6 of a cell of
 * displacement. See the note on _walkOut for why the walk is not simply a
 * straight line — and for the earlier, worse version of this same bug.
 */
const CELL_SIZE = (R_SEA * Math.PI / 2) / F;
const WALK_YIELD = 0.6;
const stepsFor = (units) => Math.max(1, Math.round(units / (CELL_SIZE * WALK_YIELD)));
/** The band a travelling spawn may land in, in world units. */
const SPAWN_FAR = DESPAWN_RADIUS - 25;
/**
 * And the near edge of a *world start*'s band, which is much closer than the
 * travelling ring's: at world start there is no view to avoid materialising
 * inside, only a body to avoid landing on. populate() used to scatter its
 * founding herd over 10..44 walk steps, which is 6 to 26 units of actual
 * displacement — an annulus of 2,000 square units, one animal per fifty, and
 * a herd that never thins out again because nothing despawns while the player
 * is still inside DESPAWN_RADIUS of it, which someone who built where they
 * woke up is all session.
 */
const SEED_NEAR = 8;
/**
 * How far out one spawn goes, in world units — and the whole of the "they are
 * mostly near the spawn area" report.
 *
 * A distance drawn flat between the near and far edge does NOT fill a ring
 * evenly. The band at 100-120 units holds eight times the ground the band at
 * 20-40 does, so serving them the same number of animals leaves the far one
 * eight times emptier. Drawing r as sqrt of a flat draw between r_near² and
 * r_far² is the standard correction and puts equal numbers per unit AREA,
 * which is the density every comment in this file is written in.
 *
 * The measured before is worse than that 8x, because the old search also
 * *travelled* badly. Eight thousand real calls to _findSpawnColumn around the
 * world spawn, histogrammed by where they actually landed:
 *
 *   band        20-40   40-60   60-80  80-100 100-120
 *   share       37.1%   28.8%   18.7%   11.2%    4.2%
 *   per 1000u²  0.099   0.046   0.021   0.010   0.003
 *
 * A 32.7x density gradient from the near edge of the ring to the far one. The
 * distance was drawn flat in *walk steps* (an 8x error on its own) and then
 * walked by _walkOut, which veers, so a step count aimed at 120 units mostly
 * fell short — the far band was under-served twice over.
 *
 * What a player sees from inside a 1/r cloud centred on themselves is exactly
 * the two things that were reported and that sound like opposites: standing
 * anywhere puts you in the dense middle of it (24 bodies inside forty units,
 * measured), and everything else — the road out, and 3,401 of the planet's
 * 3,451 land regions — is the thin outside of it. Cutting the budget thinned
 * both ends and left the gradient exactly where it was, which is why it was
 * the wrong lever and is reverted.
 */
const spawnDist = (near, far) => Math.sqrt(near * near + Math.random() * (far * far - near * near));

// --- the stalker -------------------------------------------------------------
//
// A figure that looks like you, standing where you were not looking a moment
// ago. He is not a fight and he is not an encounter; he is a sighting, and
// everything below exists to keep him one.
//
// He carries neither `hostile` nor `monster`, and that is the whole reason
// there is a third flag. `hostile` is the husk — the night budget, the cave and
// surface split, the grace wipe — and a stalker on it would eat a husk slot and
// evaporate at dawn. `monster` is targeting: it is the flag that says "this
// thing acquires the player and swings at them", which is precisely what this
// one must never do. So `phantom` is its own thing, and unlike the other two it
// mostly says what he is *exempt* from: damage, drops, prey lists, the census,
// bedding down, the save file, the vocalisation budget.
//
// The rarity is the monsters' shape — a roll per spawn tick against a cap —
// with a night term, which is the husk's shape. The two numbers below are per
// SPAWN_PERIOD (2s), so a tick is 1,800 an hour:
//
//   night  0.0035   one roll succeeds every ~570s of darkness
//   day    0.0004   one roll succeeds every ~5,000s of daylight
//
// Against MONSTER_CHANCE (0.05) that is 14x rarer at night and 125x by day, and
// those are *ceilings*: the placement below then rejects most candidate ground
// (it must be surface, unroofed, far, inside the view frustum, off-centre in it
// and with a clear line to the eye), and STALKER_REST holds off another sighting
// for five minutes after each one. A player who spends every night outdoors
// should meet him a handful of times in a long session and go whole sessions
// without. That is what the report asked for: "more at night but still rare".
const STALKER_NIGHT_CHANCE = 0.0035;
const STALKER_DAY_CHANCE = 0.0004;
/** Seconds after a sighting before the planet may roll for another. */
const STALKER_REST = 300;
/**
 * The band he may be placed in, in world units. The near edge is more than
 * twice SPAWN_MIN_DIST on purpose — "we might see him from afar" is the whole
 * brief, and a figure that resolves into a face is a mob rather than a rumour.
 */
const STALKER_NEAR = 46;
const STALKER_FAR = 92;
const STALKER_STEPS_MIN = stepsFor(STALKER_NEAR);
const STALKER_STEPS_SPAN = Math.max(1, stepsFor(STALKER_FAR) - STALKER_STEPS_MIN);
/**
 * Close this much and he is simply not there any more.
 *
 * The backstop behind the retreat, and the reason "must never catch it" is a
 * property of the code rather than a hope about the speed ladder. A chase that
 * ends in a foot race is one the player can win with a stamina bar and a flat
 * meadow; a chase that ends in an empty ridge cannot be won at all, which is
 * the only ending this thing has.
 */
const STALKER_VANISH = 24;
/** Inside this he stops watching and starts putting ground between you. */
const STALKER_RUN = 42;
/**
 * Seconds he will stay even under an unbroken stare.
 *
 * Without it a player who spots him across a valley and simply keeps looking
 * holds him there indefinitely, and a sighting you can study is not a sighting.
 * Long enough to turn, look twice and reach for something; short enough that
 * the second look is usually the one that finds nothing.
 */
const STALKER_LIFE = 13;
/**
 * Where in the frame he may arrive, as normalised device coordinates.
 *
 * Never dead centre: a figure that appears in the middle of the screen was
 * spawned, and one that appears at the edge of it was *noticed*. The upper
 * bound keeps him off the very rim, where the first frame of him would be half
 * a body clipped by the screen edge.
 */
const STALKER_EDGE_MIN = 0.32;
const STALKER_EDGE_MAX = 0.90;
/**
 * And the slack the observation test then allows, in the same units.
 *
 * Slightly outside the frame rather than exactly on it. The despawn is meant to
 * fire when the player *looks away*, not when a body a hundred units off drifts
 * one pixel past the edge while they walk — with no margin at all, a stalker
 * placed at 0.90 is three or four frames from being culled by the player's own
 * footsteps.
 */
const STALKER_MARGIN = 1.08;
/** Sample spacing of the line-of-sight walk, in world units. */
const LOS_STEP = 0.85;

/**
 * Sample spacing of the *blow* walk, and how far short of the target it stops.
 *
 * Both are much tighter than the sighting walk because the line is short. The
 * step has to be under half a cell or a wall crossed near a corner — where the
 * chord through the block is well under 1 — can fall between two samples; 0.28
 * puts at least three samples inside any block the line passes squarely
 * through. The skip only has to clear the target's own skin, and every cell a
 * body is standing in is air by construction, so it is small.
 */
const BLOW_STEP = 0.28;
const BLOW_SKIP = 0.12;

/**
 * The three rays of `_blowClear`, as (source, target) fractions of each body's
 * height, tried in order and stopping at the first clear one. Mid-to-mid first
 * because in the open it answers on its own and the other two are never walked.
 */
const BLOW_RAYS = [0.55, 0.55, 0.85, 0.90, 0.55, 0.20];

/**
 * The player's height and eye height, in cells.
 *
 * Duplicated from Player.js rather than imported: Mobs.js is handed a `player`
 * duck-type (position, up, cell, grounded, inWater) by main.js and by every
 * harness, and importing the class to read two numbers off a module constant
 * would make this file depend on the whole player. Keep in step with HEIGHT and
 * EYE in src/player/Player.js — they are 1.8 and 1.62 there.
 */
const PLAYER_HEIGHT = 1.8;
const PLAYER_EYE = 1.62;

/**
 * Seconds between line-of-sight checks while a hostile is looking for someone
 * to hunt.
 *
 * Acquisition is the only place sight is asked about, and it is asked of every
 * hostile inside its aggro ring on every frame it has no target. A husk's ring
 * is 34 cells, so an unthrottled check is a forty-sample march per husk per
 * frame for as long as one stands outside your wall — which is precisely the
 * situation this was written for, i.e. the worst case is also the common one.
 * A quarter second is four times a second, is invisible against a body that
 * takes a second and a half to cross a cell, and turns the worst case into
 * about 300 lookups a second for the whole night's worth of husks.
 */
const SIGHT_PERIOD = 0.25;

/**
 * The opening clearing: how far around the world spawn point nothing large and
 * nothing that hunts may be *placed*, in world units, and what counts as large.
 *
 * "Better if no mobs around the spawn area all sides, fishes, bees and some
 * small animals makes sense but the big ones doesn't make sense specially
 * animals that could prey on each other." Waking up between a tiger and a cow
 * is not an opening, it is a diorama, and the first thing a new player does is
 * walk into the middle of it.
 *
 * 40 units against populate()'s 8..120 band leaves 89% of the seeded disc
 * untouched, so this costs the founding herd almost nothing — it moves it
 * outward rather than thinning it. Fish and bees never see the rule at all:
 * they come from _spawnShoal and _spawnDrift, which draw their own species and
 * never go through the land draw this gates.
 *
 * 1.7 is a shade under the player's own 1.8, and it is a *size* bar rather than
 * a danger bar — the two tests below carry the danger. It keeps the bunny,
 * chick, parrot, crab, caterpillar, beaver, koala, monkey and penguin, and
 * also the cow, the deer and the panda; it excludes the polar bear, both big
 * cats, the elephant and the giraffe.
 *
 * The bar was 1.0 first, which is knee-high, and that read the request too
 * literally. What was asked for was no *big* animals and nothing that preys on
 * anything — a cow is neither, and its own note calls it "the one animal a
 * player meets in the first minute", the thing that sets the scale everything
 * else is judged against. A clearing with no cow in it is not gentler, it is
 * emptier. Forty units is about fifteen seconds' walk, which is the right price
 * for not being able to see a lion from the spawn point but the wrong one for
 * not being able to see a cow.
 *
 * And it is an *opening*, not a safe zone. Walk out of it and you meet whatever
 * the biome holds at full density with nothing softened, and the top-up ring
 * travels with the player, so the second minute is exactly as dangerous as it
 * always was. Nothing here protects a base built on the spawn point either —
 * the hearth ward is what does that, and it is earned. This buys the first
 * minute, and the first minute only.
 */
const CALM_RADIUS = 40;
// 1.7, as the note above says twice over. It read 1.0 for a long time, which is
// the value that note explicitly argues against — so the whole of the "a
// clearing with no cow in it is not gentler, it is emptier" paragraph described
// a bar the code never had. Measured against the table: at 1.0 the opening
// clearing excluded the cow (1.62), the deer (1.50) and the panda (1.32), i.e.
// the three animals the note lists by name as the ones it keeps. At 1.7 the
// exclusions are the polar bear (1.90), the elephant (3.05) and the giraffe
// (3.90) on height, and both big cats on `preyOn`/`predator` — which is exactly
// the set the note describes. Nothing hostile can reach this test: monsters
// spawn from _spawnMonster and husks from the night budget, both of which
// refuse `_nearHome` outright, and SPAWN_BY_BIOME is wildlife only.
const CALM_HEIGHT = 1.7;
/**
 * Gentle enough for the opening clearing?
 *
 * Three tests and not one, because "big" and "dangerous" are genuinely
 * different complaints and the player made both. `preyOn` is "animals that
 * could prey on each other" written as data — it is the same Set _findPrey
 * hunts from — and `predator` is the flag `fights` sets, i.e. anything that
 * hits back. The cat is the case that proves the pair are not redundant: at
 * 0.46 it is well under the height bar and it has no `fights`, but it hunts
 * chicks, and a kitten killing something in front of a new player is exactly
 * the report.
 */
const isCalm = (spec) => spec.height <= CALM_HEIGHT && !spec.preyOn && !spec.predator;

// --- vocalisation pacing ----------------------------------------------------
// Each animal keeps its own jittered clock, seeded at random on spawn, so a
// herd that spawned in the same frame never calls in unison. On top of that the
// manager holds a global cooldown, so 16 animals whose clocks happen to line up
// still produce one call, not sixteen.
const VOX_MIN = 6;            // seconds between one animal's own calls
const VOX_MAX = 14;
const VOX_NEAR = 14;          // world units — always audible, even behind you
const VOX_RANGE = 42;         // beyond this, silent regardless of facing
const VOX_FACING = 0.25;      // cos of the half-angle counted as "on screen"

// The merchant's bell is a beacon, not a vocalisation: it has to carry across
// open ground so "walk towards the sound" is a real way to find one.
// Knockback. Short and sharp: long enough to break contact and reset the
// exchange, short enough that a husk is on you again before you have finished
// congratulating yourself.
const KNOCK_TIME = 0.34;        // seconds of push
// Cells per second at full strength, before knockMass below has its say — a
// husk stands 1.72 and so lands at 6.4, near enough where it always was, while
// the elephant and the big cats that share this number are shifted by what
// they weigh rather than by what they are called.
const KNOCK_HOSTILE = 7.0;
/**
 * And for an animal. This was 3.4, which over KNOCK_TIME with a linear decay
 * comes to 0.58 of a cell — half a block, less than a cow is long, and gone
 * inside a third of a second. "There should be a knockback when I hit them"
 * was not asking for a mechanic that did not exist; it was reporting one that
 * existed and could not be seen.
 */
const KNOCK_WILDLIFE = 6.0;
/**
 * How much of the shove an uncharged blow carries.
 *
 * main.js hands hurt() a `knock` of 1 or 0 on either side of an 85% charge, so
 * a hurried swing landed with *no* shove whatsoever — the commonest way to hit
 * anything is a click, and a click did nothing visible. Timing still matters,
 * three times over, but a blow that connects always moves what it hits.
 */
const KNOCK_FLOOR = 0.35;
/**
 * Mass, as far as being hit is concerned.
 *
 * Taken off the drawn height rather than from a number per species, because
 * the species table already spans an order of magnitude of size (0.22 to 3.9)
 * and a second, hand-kept column of weights would only be that one paraphrased
 * — and would drift from it the first time a height was retuned. The
 * individual's own height is used, jitter and all, so the runt of a herd is
 * genuinely easier to shift than the bull.
 *
 * The exponent is deliberately nearer 1 than the 3 a real mass would want.
 * Volume goes with the cube of the length, so a true impulse-over-mass shove
 * would move a bunny about a thousand times as far as a giraffe, and the
 * bottom half of the table would simply be launched out of the world. What
 * this gives, against a cow at the reference height:
 *
 *   chick / bee  0.26   2.40x (clamped)   14.4 cells/s — it leaves
 *   bunny        0.36   2.40x (clamped)   goes over the cliff you meant it to
 *   fox          0.58   3.1 -> 2.40x
 *   cow          1.62   1.00x              6.0 cells/s, about a cell of ground
 *   polar bear   1.90   0.83x
 *   elephant     3.05   0.49x              rocks, and is where it was
 *   giraffe      3.90   0.37x
 */
const KNOCK_REF_H = 1.6;
const KNOCK_MASS_POW = 1.1;
const KNOCK_MASS_MIN = 0.35;
const KNOCK_MASS_MAX = 2.4;
const knockMass = (h) => clamp(
  Math.pow(KNOCK_REF_H / Math.max(0.05, h), KNOCK_MASS_POW), KNOCK_MASS_MIN, KNOCK_MASS_MAX,
);
/**
 * The pop that gets a struck animal off its feet, on the same mass curve.
 *
 * Without it the shove is a slide, and a slide is eaten by the ground: the
 * floor clamp puts the body straight back down, the footprint test is asked
 * whether it may go where it is going, and the answer to that is the whole of
 * the second report — see the tumble in update(). Airborne, a bunny arcs about
 * 1.3 cells up and hangs for two thirds of a second, which is time enough to
 * be over the water; an elephant lifts five centimetres.
 */
const KNOCK_LIFT = 3.4;

const BELL_RANGE = 120;
const BELL_MIN = 4.5;
const BELL_MAX = 8;

const TAU = Math.PI * 2;

// Dedicated scratch. Each one has a single owner in a given scope; this file
// has had aliasing bugs before, so never borrow one across a helper call.
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _axis = new THREE.Vector3();
/** Player collision radius, matching HALF_W in Player.js. */
const PLAYER_RADIUS = 0.34;

const _seam = new THREE.Vector3();
const _rel = new THREE.Vector3();

/**
 * Neighbour lookup for _separate: a uniform hash grid over world position.
 *
 * Measured before touching it, because the audit that sent me here had the
 * attribution wrong and it was worth knowing by how much. The all-pairs loop
 * costs a flat 41.5ns per pair — 52us a frame at 60 bodies, 214us at 120, 249us
 * at the current cap of 134, and 3,303us at 400. That is a clean n² line, and
 * it is what makes the cap immovable: it is not the bill at 134 that hurts, it
 * is that every extra body costs more than the last one did.
 *
 * A flat 3D hash on the world-space position, deliberately, rather than
 * anything in cell space. Bodies are spread over a sphere and the cube-face
 * seams are exactly where column arithmetic goes wrong; world position has no
 * seams in it at all, so the question never comes up. The cost is that the
 * table is keyed on three signed ints instead of one, which is three compares
 * on a candidate and nothing on a miss.
 *
 * Cell size is the largest reach any pair can have (twice the largest radius in
 * the list, recomputed each frame — a tiger that has eaten its way larger, or
 * a giraffe walking into the ring, both move it). Two bodies that overlap are
 * then always within one cell of each other on every axis, so the 27-cell scan
 * is exact: nothing that would have been pushed is skipped, which is the same
 * bound the old squared-distance early-out relied on.
 *
 * Buckets are shared between cells that happen to hash together. That is
 * harmless for correctness of the *set* of pairs, but not for the count: two
 * different neighbour cells landing in one bucket would hand back the same body
 * twice and push it twice. So each body's cell is stored exactly and checked on
 * the way out, which makes a body appear once, from its own cell, or not at all.
 */
let _gHead = new Int32Array(0);   // bucket -> newest body in it, -1 for empty
let _gNext = new Int32Array(0);   // body -> next body in the same bucket
let _gCx = new Int32Array(0);     // body -> its exact grid cell, so a shared
let _gCy = new Int32Array(0);     // bucket cannot return the same body from two
let _gCz = new Int32Array(0);     // different neighbour cells
let _gCand = new Int32Array(0);   // partners found for one body, sorted
let _gMask = 0;
const gridHash = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791));
/** Grow the scratch to hold `n` bodies. Never shrinks; MAX_MOBS bounds it. */
function gridFit(n) {
  if (_gNext.length >= n) return;
  const want = Math.max(64, n);
  _gNext = new Int32Array(want);
  _gCx = new Int32Array(want);
  _gCy = new Int32Array(want);
  _gCz = new Int32Array(want);
  _gCand = new Int32Array(want);
  // Half load at the cap, which keeps the chains at one body each in the case
  // that matters — bodies spread over terrain, not piled on one point.
  const cap = 1 << (32 - Math.clz32(Math.max(1, want * 2 - 1)));
  _gHead = new Int32Array(cap);
  _gMask = cap - 1;
}

const _ray = new THREE.Vector3();
const _rpos = new THREE.Vector3();
const _vox = new THREE.Vector3();
/** Where a mob's block light is sampled, and what comes back. */
const _lit = new THREE.Vector3();
const _blockL = { r: 0, g: 0, b: 0 };
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = [0, 0, 0];
const _probe = { f: 0, ci: 0, cj: 0, ck: 0 };
/** Two more of the same, for _walkTo's aim-measure-correct. */
const _wa = [0, 0, 0], _wb = [0, 0, 0];
/** The stalker's own scratch: view-projection, the point it puts on screen, and
 * the marching head of the line-of-sight walk. */
const _vpm = new THREE.Matrix4();
const _ndc = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _los = new THREE.Vector3();
// Endpoints of a blow ray. Kept apart from _eye/_los because _lineOfSight
// scribbles on _los, and _blowClear holds both of its endpoints across the call.
const _ptA = new THREE.Vector3();
const _ptB = new THREE.Vector3();
const _seen = new THREE.Vector3();

const wrapAngle = (a) => {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
};

// --- species ----------------------------------------------------------------
// Every mob is a Kenney GLB with its animation already authored: eight clips
// per animal, keyed on named nodes rather than a skeleton. Sizes are given as a
// target height in cells and the per-model scale is derived from the measured
// rest pose, so a species can be swapped for a different model without
// re-tuning numbers by hand.

const PET = (n) => `models/pets/animal-${n}.glb`;
const CHAR = (n) => `models/characters/character-${n}.glb`;

/**
 * Clip names shipped by the Cube Pets rig.
 *
 * There is no attack clip, and no fifth clip hiding in the pack either — every
 * animal in Cube Pets ships idle/walk/run/eat and that is the whole export. So
 * `attack` is deliberately absent rather than pointed at a clip that does not
 * exist: playOnce returns 0 for a name it cannot find, which is silent, and a
 * silent swing is exactly how a tiger came to hit you with nothing on screen.
 * _hunt builds a lunge out of the run clip and a scale pop instead — see the
 * comment on the swing there.
 */
const PET_CLIPS = { idle: 'idle', walk: 'walk', run: 'run', graze: 'eat' };

/**
 * The fish pack, which speaks a different animation language from the animals.
 *
 * Its clips are named by the exporter after the armature that owns them, and
 * there is no walk or eat — a fish only ever swims, at two speeds. So `idle`,
 * `walk` and `graze` all map to the same unhurried stroke and only a fleeing
 * fish gets the fast one, which is exactly how a fish reads.
 */
const FISH = (n) => `models/fish/fish-${n}.glb`;
const FISH_A = 'Fish_Armature|Fish_Armature|';
const FISH_CLIPS = {
  idle: `${FISH_A}Swimming_Normal`,
  walk: `${FISH_A}Swimming_Normal`,
  run: `${FISH_A}Swimming_Fast`,
  graze: `${FISH_A}Swimming_Normal`,
  die: `${FISH_A}Death`,
};
/**
 * Which of them swim in ordinary water.
 *
 * `betta` and `goldfish` join the shoal here, and they are the last two bodies
 * in the pack that were converted and never spawned. Every one of these is now a
 * catchable item as well (see `FISH_SPECIES` in `Items.js`), and a species you
 * can pull out of a lake but never see swim in one is the player's report
 * inverted rather than answered — so the list a rod draws from and the list the
 * water is stocked from are the same eleven names.
 *
 * What is deliberately still missing is a *salinity* split. The spawner picks a
 * variant out of `urls` with the seeded stream and knows nothing about the
 * column it is filling, so a koi can turn up in the ocean exactly as it always
 * could. `_rollCatch` does know — it is handed the cast's own water — so the
 * rod already keeps fresh and salt apart. Making the shoals do the same means
 * threading the column's salinity through `spawn`, and that is worth doing on
 * its own rather than inside this.
 */
const FISH_KINDS = [
  'clownfish', 'bluetang', 'butterflyfish', 'moorishidol',
  'yellowtang', 'royalgramma', 'koi', 'tetra', 'puffer',
  'betta', 'goldfish',
];
/**
 * The ones that live where the light does not reach. Same rig and the same
 * clips — the pack is consistent — so they are a second species rather than a
 * second system, told apart only by where they are allowed to spawn.
 */
const DEEP_KINDS = ['anglerfish', 'blobfish', 'goblinshark'];
/** How many layers of water count as deep enough for them. */
const DEEP_WATER = 8;

// --- the monsters ------------------------------------------------------------
//
// A third category beside the animals and the husk, and it has to be a third
// rather than a variety of husk, because `hostile` does not mean "attacks you".
// It means husk specifically: it drives the night spawn budget, the cave and
// surface split, and the wipe that clears a new world's first evening. A
// monster carrying it would eat that budget and evaporate at the grace wipe.
//
// So `monster` is its own flag, and the split falls along what each thing
// answers. Targeting is shared — a monster acquires you exactly as a husk does,
// because once something has decided on you the chase is the same. Budgets,
// the census, bedding-down and the wipe stay keyed on `hostile` alone, which is
// what lets these walk about in daylight.
const MON = (n) => `models/monsters/monster-${n}.glb`;
/**
 * They speak the pack's own animation language, and there are two dialects: the
 * walkers carry Idle and Walk, the fliers carry only Flying. So a flier maps
 * every gait onto the one clip it has, which is right — a bat does not stand
 * still.
 */
const MONSTER_CLIPS = {
  idle: 'Idle', walk: 'Walk', run: 'Walk', graze: 'Idle',
  die: 'Death', attack: 'Bite_Front',
};
const FLYER_CLIPS = {
  idle: 'Flying', walk: 'Flying', run: 'Flying', graze: 'Flying',
  die: 'Death', attack: 'Bite_Front',
};

/**
 * @param {string} file model basename
 * @param {object} o the same shape `pet` takes, plus `flies`
 */
/**
 * How much tougher a thing that hunts you is than an animal of the same size.
 *
 * The weapon ladder was re-spaced so every tier buys a legible step, and it
 * still could not give five distinguishable rungs against a husk: on a fourteen
 * point bar the fight ran 4/3/3/2/2 hits, so two of the five upgrades bought
 * nothing at all. No ladder of any shape fixes that, because the bar is too
 * short to divide five ways.
 *
 * So the hostiles get the room instead, and only the hostiles: a uniform 1.5 on
 * everything that hunts, and nothing at all on the animals. That keeps the long
 * species-pricing comment above true term for term, since every monster moves
 * together, and it keeps a bunny at four health rather than turning the wildlife
 * into sponges. A husk at 21 runs 6/5/4/3/2, which is exactly one hit bought per
 * tier on the fight a new player actually has.
 */
const HOSTILE_HP = 1.5;

const monster = (file, o) => ({
  ...pet(file, { ...o, diet: 'carnivore', hp: Math.round(o.hp * HOSTILE_HP) }),
  urls: [MON(file)],
  // Which clip set, decided by what the model actually carries rather than by
  // whether it flies — the two are not the same question. Only the bat, the
  // cthulhu and the dragon are built on the pack's flying rig; the ghost hovers
  // in this game but is animated as a walker, and handing it the flying map
  // left it with no clip at all. A monster standing perfectly still in its rest
  // pose while gliding at you is not the effect anyone wanted.
  clips: (o.flyAnim ?? o.flies) ? FLYER_CLIPS : MONSTER_CLIPS,
  monster: true,
  fights: true,
  // How far off it notices you. Deliberately shorter than a husk's, because a
  // monster is a thing you come across rather than a thing that comes for you.
  aggroRange: o.aggro ?? 13,
  damage: o.dmg ?? 4,
  reach: o.reach ?? 1.5,
  swing: o.swing ?? 1.3,
  ...(o.flies ? { flies: true, hover: o.hover ?? 2.2 } : null),
  // Self-lit, 0 for everything that is not. `pet()` and this builder both drop
  // fields they do not name, so a spec can carry `glow` only because this line
  // exists - a typo here is invisible rather than loud.
  ...(o.glow ? { glow: o.glow } : null),
});
/** Clip names shipped by the Blocky Characters rig — no eat, but it can fight. */
const CHAR_CLIPS = {
  idle: 'idle', walk: 'walk', run: 'sprint', graze: 'idle',
  attack: 'attack-melee-right', die: 'die',
};

// --- the stalker's eyes ------------------------------------------------------
//
// The one thing the Blocky Characters pack cannot give us. A face on this rig
// is *painted*: the whole body is one material, one 1024² palette atlas, and
// the eyes are two brown squares in it. There is no eye material to make
// emissive, and there is no separating them from the shins without touching the
// texture — which is the one thing `lit()` spends a paragraph telling you never
// to do. Writing any property that forces a re-upload of these maps renders the
// model flat white, because the ImageBitmap behind them has already been
// consumed. Recolouring the atlas is that bug with extra steps.
//
// So the glow is geometry: two unlit quads sitting a hair proud of the face,
// parented to the `head` node so they nod and tilt with every clip the rig
// plays. No asset is added — a PlaneGeometry and a MeshBasicMaterial, both
// shared by every stalker that ever spawns and therefore never disposed, which
// is the same contract the model prototypes keep.
//
// Every number is measured, not guessed. The head is node `head` — translation
// (0, 1.2, 0) under `torso`, uniform scale 0.1, mesh box (-4,0,-4)..(4,8,4) —
// identically so in all eighteen `character-*.glb`, so these coordinates are
// the head's own local space and hold for whichever body the player chose. The
// face is the +Z side (see the orientation note in _animate: +Z is forward),
// and it maps to u 0.130..0.245, v 0.120..0.248 of the atlas. Reading the eyes
// out of that crop puts their centres at x = ±2.0, y = 3.72 — a shade below the
// middle of the head — and makes each one about 1.0 x 1.05 units across.
const EYE_X = 2.0;
const EYE_Y = 3.72;
/** Just proud of the face at z = 4, by enough to never z-fight at 90 units. */
const EYE_Z = 4.15;
/** A little wider than the painted eye, so it reads as a glow over it. */
const EYE_GEOM = new THREE.PlaneGeometry(1.5, 1.15);
/**
 * Unlit, untonemapped, unfogged, and all three on purpose.
 *
 * MeshBasicMaterial is the one material in the file we *want* to leave unlit —
 * `lit()` exists to stop a textured body ignoring the sun, and this is the
 * opposite case: two lights that must not dim at midnight, which is exactly
 * when they matter. `toneMapped: false` keeps them at full white through the
 * exposure curve, and `fog: false` stops ninety units of atmosphere washing out
 * the only part of him you are meant to be able to make out at that range.
 *
 * Deliberately *not* pushed onto `model.owned`. That list is the per-mob
 * material clones and _release disposes it; this one is shared with every other
 * stalker, and disposing it would blank the eyes of the next one.
 */
const EYE_MAT = new THREE.MeshBasicMaterial({
  color: 0xe8f4ff, toneMapped: false, fog: false,
});

/**
 * How much one individual may differ from its species' height, as a fraction
 * either way. The old range was a flat 0.90..1.10 for everything, which reads
 * on a giraffe (±0.39 cells) and is invisible on a chick (±0.026 cells — three
 * millimetres). Species that want it wider or narrower say so with `var`.
 */
const SIZE_VAR = 0.12;

/**
 * One animal. Only what differs is written out; everything else takes a sane
 * default, which is what keeps a 22-species table readable.
 *   h    target height in cells      shy  0 never flees .. 1 bolts on sight
 *   hp   health                      spd  cells/second at a *wander*
 *   var  ± height spread per head    dmg  half-hearts a blow costs the player
 *
 * `spd` is the amble, not the top speed — a chase multiplies it by CHASE_SPEED
 * and a bolt by FLEE_SPEED. See the speed ladder below the damage ladder for
 * why the burst lives in the multiplier rather than in this number.
 *
 * Heights are the *drawn* height of the whole animal — ears, antlers, raised
 * head and all — against a player who stands 1.8. They are the only lever on
 * apparent size: the scale is derived from the measured rest pose, so a model
 * gets its bulk for free once its height is right.
 *
 * `fights` makes a species dangerous once you have hit it, and that is now the
 * only way any animal becomes dangerous to the player. There used to be a
 * `hunts` flag as well, which let a lion or a tiger acquire the player on sight
 * — and it was the first thing a player complained about, unprompted: "I didn't
 * even attack the lions and tigers but they are attacking me". A world where
 * walking across a savanna is a fight you did not pick is not a wilder world,
 * it is a smaller one, because the answer to it is to stay indoors. Coming for
 * you unasked is the husk's whole job and it should stay the husk's alone.
 *
 * Predation is untouched by this: `eats` is what a carnivore hunts, and it
 * hunts that freely. A tiger pulling down a deer across the clearing is the
 * ecology; a tiger deciding *you* are the deer is a different game.
 *
 * `stalks` is the one exception, and it is deliberately not the old behaviour
 * under a new name: a hungry big cat, at night only, rarely, walks you down in
 * the open with a long telegraph before it commits to anything. See _prowl.
 *
 * `fights` is kept clear of `hostile`, which means husk specifically: that flag
 * drives the night spawn budgets and the new-world grace wipe in main.js, and a
 * tiger caught by it would either starve the husk cap or vanish at dawn.
 */
const pet = (file, o) => ({
  label: o.label,
  urls: [PET(file)],
  clips: PET_CLIPS,
  height: o.h,
  sizeVar: o.var ?? SIZE_VAR,
  health: o.hp,
  speed: o.spd,
  skittish: o.shy,
  turn: o.turn ?? 3.5,
  accel: o.accel ?? 7,
  drops: o.drops ?? [],
  // What it eats: 'herbivore' | 'carnivore' | 'omnivore'. A carnivore never
  // grazes, and that is enforced here rather than at the call site — the
  // behaviour state machine goes on asking the one question it always asked
  // ("graze or idle?"), and a lion simply never answers grass. A player
  // watching a lion chew a meadow is the kind of detail that unpicks a whole
  // world, and a `if (spec.diet !== ...)` sprinkled through the state machine
  // is how that rule ends up applied in three places and forgotten in a fourth.
  diet: o.diet ?? 'herbivore',
  // Exactly which species this one hunts, by name, as data.
  //
  // Prey used to be "anything at most PREY_SIZE times my own height", and the
  // player's verdict on that was "why would a lion or a tiger eat a crab?".
  // There is no size rule that answers that, because the question is not about
  // size — it is about what a lion eats. A ceiling that lets a lion take a deer
  // lets it take a crab, a bee and a caterpillar too, and every attempt to
  // patch that with another dimension (is it aquatic? is it an insect?) is a
  // taxonomy being rediscovered one conditional at a time. So the list is
  // written out, on the spec where the rest of the species lives, and the size
  // test stays only as a sanity check behind it — see _findPrey.
  preyOn: o.eats ? new Set(o.eats) : null,
  grazeChance: o.diet === 'carnivore' ? 0 : (o.graze ?? 0.5),
  idleMin: o.idleMin ?? 2,
  idleMax: o.idleMax ?? 5,
  ...(o.hops ? { hops: true, hopImpulse: o.hopImpulse ?? 3.8 } : null),
  ...(o.cold ? { cold: true } : null),
  ...(o.aquatic ? { aquatic: true } : null),
  // Aquatic is "water is the only place I will go"; amphibious is "water is not
  // a wall". They are separate because they are not two ends of one axis: a
  // fish drowns on the bank, a crab is perfectly happy there and simply wants
  // to be able to get across the shallows. `shore` is the other half of a
  // crab — a pull back toward the water line, so it lives on a beach rather
  // than wandering off into the dunes.
  ...(o.amphibious ? { amphibious: true } : null),
  ...(o.shore ? { shore: true } : null),
  ...(o.stalks ? { stalks: true } : null),
  // Foliage is floor to this one. Spelled out here like every other flag
  // because this builder copies nothing it has not been told about — a
  // `climbs: true` left on the species literal alone is silently dropped, and
  // the only symptom is a monkey that keeps both feet on the ground.
  ...(o.climbs ? { climbs: true } : null),
  ...(o.flies ? { flies: true, hover: o.hover ?? 1.5 } : null),
  ...(o.fights ? {
    predator: true,
    damage: o.dmg ?? 2,
    reach: o.reach ?? 1.2,
    swing: o.swing ?? 1.2,
    // A retaliating animal still needs a range, or `dist > range * 1.6` can
    // never be true and it holds its grudge across the whole planet.
    aggroRange: o.aggro ?? 16,
  } : null),
});

const HIDE_MEAT = [['hide', 1, 1], ['meat', 1, 1]];

// Everything below is sized against the player's 1.8. The table used to sit in
// a band from 0.4 to 1.55 for everything short of an elephant, and at that
// spacing a cow, a deer, a fox and a tiger all read as the same animal in
// different colours — which is exactly what a player reported. Sizes are now
// spread over an order of magnitude instead: a caterpillar at 0.22 against a
// giraffe at 3.9, with the player sitting a little above halfway.
//
// Two ceilings are worth knowing about before pushing anything higher.
// modelExtents rounds the drawn height up into `tall`, the headroom a body
// needs to walk, so 3.9 costs a giraffe four clear blocks and 4.1 would cost it
// five — enough to wall it out of most of the terrain it lives on. The halfW /
// halfL clamp used to be the second, and is no longer a flat number — see
// modelExtents for what replaced it and why.
//
// --- the damage ladder -------------------------------------------------------
// `dmg` is points off a twenty-point bar, i.e. half-hearts. It was set one
// species at a time and the result was not a ladder at all: work the numbers
// into damage per second and a fox did 2.35, a husk 2.6, an elephant 2.8 and a
// tiger 3.5. Four animals that are meant to read as four completely different
// kinds of trouble were inside fifty percent of each other, and the two ends of
// the range — the thing you shoo away and the thing that can kill you — were
// almost indistinguishable in play. That is the "damage scaling is wrong"
// report, and no single number fixes it; the whole set has to be laid out at
// once.
//
// Three facts set the scale, and all three are worth stating because they make
// the big numbers below far less brutal than they look:
//
//   1. Nothing on this planet acquires the player on its own except the husk
//      and the night stalk. Every one of these fights is one the player picked,
//      and every one of them can still be left — a sprint outruns the fastest
//      chase on the planet. Damage is the price of engaging, not a tax on being
//      outdoors, which is the same principle that removed unprovoked aggression.
//      This used to read "nothing on this planet can catch the player", and that
//      was the flaw the whole ladder was resting on: at a top speed of 1.8
//      against a walk of 4.4 no fight could start unless the player stood still,
//      so every number below was theoretical. Leaving now costs stamina rather
//      than costing nothing — see the speed ladder.
//   2. main.js grants HURT_IMMUNITY (0.5s) after every guarded blow, so a pack
//      cannot burst you down and a species' threat really is its own DPS.
//   3. Worn armour soaks up to 80% of a blow. The top of this ladder is
//      therefore also the argument for a chestplate.
//
// Read as seconds to kill a standing, unarmoured player from full:
//
//   fox        1 / 1.00s   1.0 dps   20s   a nuisance; you can ignore it
//   dog        2 / 1.00s   2.0 dps   10s
//   bee        4 / 1.60s   2.5 dps    8s   burst, not pressure — see below
//   husk       3 / 1.15s   2.6 dps  7.7s   unchanged: the night's baseline
//   polar      6 / 1.35s   4.4 dps  4.5s
//   lion       5 / 1.25s   4.0 dps  5.0s
//   tiger      6 / 1.15s   5.2 dps  3.8s   the most dangerous thing that hunts
//   elephant   8 / 2.00s   4.0 dps  5.0s   but three blows and you are dead
//
// Every number in that column is the *normal* ladder. The world's difficulty
// multiplies all of them by one factor — 0.5, 1 or 1.5 — on the one wire these
// blows cross, `Mobs.onAttack` in main.js, so the ratios priced here survive
// exactly and nothing but a mob's blow is touched. See MOB_DAMAGE_SCALE in
// game/NewGame.js for why those three.
//
// The elephant is deliberately the odd one out: mid-table on DPS and top of the
// table per blow. It is slow, it telegraphs, and walking away always works, so
// the lesson it teaches has to be carried by the single hit rather than by
// attrition — losing forty percent of the bar for standing in front of one is
// the lesson. A tiger has the opposite shape: less per blow, but it keeps
// landing them.
//
// --- the speed ladder --------------------------------------------------------
// The damage ladder above was built on the assumption that nothing could reach
// you, and the speeds made that literally true: the fastest land animal walked
// at 1.5 against a player who *strolls* at 4.4 and sprints at 6.8. You outran a
// tiger by three times without pressing anything. A tiger that cannot close is
// not a tiger, and a lion that cannot run down a cow is not an ecology either —
// prey fled at 2× its walk and predators chased at 1×, so a cow at 1.7 was
// genuinely faster than the tiger at 1.5 chasing it, and kills happened only
// because the flee state times out.
//
// Two ways to fix that, and the choice matters:
//
//   a) raise `spd` until a tiger walks at 5.7. Rejected. `spd` is the wander
//      pace, and an animal that *mills about a meadow* at 5.7 cells/s is not
//      dangerous, it is frantic — a cow at 3 looks like a cow being electrified.
//      Worse, `spd` is also the animation's reference gait: the walk clip is
//      played at speedNow/spec.speed, so it runs at exactly 1.0 whatever the
//      base is. Doubling `spd` doubles the ground covered per footfall and every
//      animal on the planet skates at its own amble.
//   b) give chasing and fleeing their own multipliers on top of the wander, so
//      the burst is a *state* and the amble stays an amble. Chosen.
//
// (b) also lands the fast movement on the run clip, where it is paid for: the
// clip swaps to `run` above spec.speed * 1.25 and its rate is speedNow divided
// by spec.speed * 2, so a multiplier of M plays the run at M/2. That is why the
// old flee multiplier was exactly 2.0 — it hit a rate of 1.0 on the nose. The
// setEffectiveTimeScale clamp is 0.45..2.2, i.e. multipliers from 0.9 to 4.4;
// both numbers below sit comfortably inside it and nothing here can skate.
//
// The three speeds every number is set against, walk 4.4 / sprint 6.8:
//
//   fox        4.35   just under a walk — you *can* stroll away from a fox, and
//                     its damage note says exactly that, so now it is true
//   husk       3.84   comfortably under a walk: you can always leave one, but
//                     you cannot dawdle. (This read 4.50 for a long time, off
//                     the 1.50 the husk's own spec note explains it no longer
//                     has. See `speed` on the husk.)
//   dog        4.65   as the fox, but it keeps up
//   polar/cat  4.80
//   lion       5.40
//   tiger      5.70   the fastest thing with teeth that can reach you, and
//                     walking away no longer works. Not the fastest thing with
//                     teeth full stop — that is the piranha at 5.85, and the
//                     shark is 5.55; neither has `fights`, so neither is on
//                     this ladder, and both are on the wrong side of the
//                     shoreline in any case.
//   bee        6.30   the fastest thing full stop, and it has 3hp
//   elephant   3.00   deliberately below a walk: its whole lesson is the single
//                     blow, and "walking away always works" is what makes that
//                     lesson survivable. Left slow on purpose.
//
// Nothing reaches 6.8. A sprint always opens ground, and HUNT_STALL then ends
// the chase after nine seconds of not closing — so escape is guaranteed but it
// costs about half the stamina bar (0.055/s drain) rather than costing nothing.
// That is the whole design: getting away should be something you do, not the
// default state of walking forwards.
//
// On the prey side FLEE is deliberately well under CHASE, so a committed hunter
// genuinely runs its dinner down instead of relying on the flee timer lapsing.
// Every flee speed stays under the player's sprint, and every one of them on
// four legs stays under the player's *walk* — the fastest is the bunny at 4.07
// and a strolling player still gains on it. A cow you cannot reach is a cow you
// cannot farm. The two exceptions are both airborne and both deliberate: the
// bee bolts at 4.62 and the parrot at 5.72, so a bird that has decided to leave
// is gone unless you sprint. (5.72 is over a walk, which the earlier version of
// this note did not say; it is a consequence of the parrot's 2.60 amble, which
// exists so that a bird at canopy height reads as flying rather than hovering,
// and it costs nothing — a parrot is not something you catch on foot.)
/** A committed chase, as a multiple of the wander pace. */
const CHASE_SPEED = 3.0;
/** A bolt. Lower than a chase on purpose — see the ladder above. */
const FLEE_SPEED = 2.2;

/**
 * ...and the same thing again for a hunt, where the ladder above does not apply.
 *
 * Everything in the ladder is priced against the player: a fox chases at 4.35
 * because a fox is a thing you can stroll away from. Predation was reading the
 * same number and it does not mean the same thing there, because a fox is not
 * chasing the player, it is chasing a bunny that bolts at 1.85 x FLEE_SPEED =
 * 4.07. Measured, a fox closed on a bunny at 0.28 cells/s and a dog at 0.58,
 * against a PREY_GIVE_UP of twelve seconds — so neither could take one from
 * beyond about four cells, and the fox then needed four bites at BITE_PERIOD to
 * finish a 4hp rabbit. "Carnivores hunt the herd" was true of the big cats and
 * of nothing small. A fox that cannot catch a rabbit is not a predator, it is a
 * fox-shaped animation that runs behind rabbits.
 *
 * A flat multiplier cannot fix it: a fox ambles at 1.45 and a bunny at 1.85, so
 * any number that is the same for both leaves the fox behind. The pace is
 * therefore taken from the animal being chased — a hunter runs at whatever its
 * dinner is running at, plus a margin — which is both the honest description of
 * a chase and, usefully, self-limiting:
 *
 *   - it only ever raises the pace of a hunter whose prey is fast relative to
 *     it. A lion on a cow, a shark on a fish, a piranha on anything: the flee
 *     speed is already well under CHASE_SPEED x the hunter's own amble, so the
 *     clamp holds them at exactly the 3.0 they run at today and not one of
 *     those pairings changes at all;
 *   - it is bounded by a ceiling, which matters twice over. It keeps the
 *     fastest hunt on the planet at about 5.5 cells/s — under the bee's 6.3,
 *     which is the speed the movement code is sized against (see _throwStep on
 *     why a step per frame is safe at that pace and not at any pace) — and it
 *     keeps the run clip legal: the rate is M/2 against a clamp of 2.2, so 4.0
 *     is the largest multiplier that does not skate.
 *
 * The kill RATE is untouched by any of this, which is the point of doing it
 * here rather than by loosening PREY_GIVE_UP or PREY_REST. A carnivore still
 * eats once per PREY_REST and nothing else has moved; what changes is that the
 * hunts it spends that clock on can now succeed, which is what the note at the
 * top of this block already claimed was true.
 */
const PREY_CLOSE = 1.6;         // cells/second a hunter aims to gain on its prey
const PREY_CHASE_MAX = 4.0;     // ...and the most it may multiply its amble by
/**
 * Bites to bring prey down, and why predation does not use the damage ladder.
 *
 * `spec.damage` is a price on fighting the *player* — a fox does 1 because a
 * fox is meant to be a nuisance you can walk away from mid-bite. Spending that
 * number on a rabbit made the smallest hunters unable to finish what they had
 * caught: four bites at BITE_PERIOD is six seconds of a fox standing on a
 * rabbit inside a twelve-second give-up window that is also paying for the
 * chase. The old expression was `spec.damage ?? 4`, and the fallback was its
 * own bug — the cat has no `fights` and so no damage, which handed the one
 * animal on the planet that explicitly does not fight the biggest bite in the
 * table, twice the dog's. There is now nothing to fall back to.
 *
 * So a hunt lands in a fixed number of bites whatever is doing the biting, and
 * the chase between them — which is what BITE_PERIOD exists to produce — is
 * still there, twice. A hunter that hits harder than that still hits harder:
 * the max keeps a tiger's bite a tiger's bite rather than capping it at half a
 * deer.
 */
const PREY_BITES = 2;

const SPECIES = {
  // --- large grazers ---
  cow: pet('cow', {
    // Head-high on the player and twice the width of a deer. The one animal a
    // player meets in the first minute, so it sets the scale for the rest.
    label: 'Cow', h: 1.62, var: 0.18, hp: 10, spd: 1.10, shy: 0.35, turn: 2.0, accel: 4.5,
    graze: 0.6, idleMin: 3, idleMax: 7, drops: [['hide', 1, 2], ['meat', 1, 2]],
  }),
  deer: pet('deer', {
    // Slightly shorter than the cow and far slighter. It stands tall for its
    // mass rather than being large, which the model already says — the job here
    // is only to stop it matching the cow number for number.
    label: 'Deer', h: 1.50, var: 0.14, hp: 10, spd: 1.70, shy: 0.9, turn: 3.0, accel: 6.0,
    idleMin: 2.5, idleMax: 6, drops: [['hide', 1, 2], ['meat', 1, 2]],
  }),
  elephant: pet('elephant', {
    label: 'Elephant', h: 3.05, var: 0.14, hp: 20, spd: 1.00, shy: 0.2, turn: 1.6, accel: 3.5,
    graze: 0.6, idleMin: 3, idleMax: 8, drops: [['hide', 2, 3], ['meat', 2, 3]],
    // It does not hunt, but standing in front of one is a mistake. Slow, so
    // walking away works — which is exactly why the lesson has to be in the
    // single blow rather than in the DPS. Eight is the heaviest hit anything
    // lands: three of them kill from full, and one of them is unmistakable.
    fights: true, dmg: 8, reach: 1.9, swing: 2.0, aggro: 14,
  }),
  giraffe: pet('giraffe', {
    // The tallest thing that walks. 3.9 and not 4.0 on purpose: see the note
    // above about `tall`.
    label: 'Giraffe', h: 3.90, var: 0.15, hp: 14, spd: 1.20, shy: 0.5, turn: 1.8, accel: 4.0,
    graze: 0.55, idleMin: 3, idleMax: 7, drops: [['hide', 1, 2], ['meat', 1, 2]],
  }),
  panda: pet('panda', {
    label: 'Panda', h: 1.32, hp: 14, spd: 0.80, shy: 0.3, turn: 2.2, accel: 4.0,
    graze: 0.7, idleMin: 3, idleMax: 8, drops: [['hide', 1, 2], ['meat', 1, 2]],
  }),
  polar: pet('polar', {
    // Taller than the player, and the only thing on the ice that is.
    label: 'Polar Bear', h: 1.90, hp: 16, spd: 1.60, shy: 0.3, turn: 2.4, accel: 5.0,
    // Fish on a quarter of kills, from the same `eats` list two lines down: it
    // lives on fish, so some of the time it is carrying one. Deliberately a
    // garnish and not a source. A base bear already pays 11-18 coins (hide 3-4
    // at 3, meat 1-3 at 2) and one raw fish sells for 2, so this is +0.5 coins
    // expected, ~3%; a rod pulls a fish per cast, and nothing here should make
    // hunting bears a way around fishing.
    diet: 'carnivore', drops: [['hide', 2, 3], ['meat', 1, 2], ['fish', 1, 1, 0.25]], cold: true,
    // It fishes, so it swims — and it has to, or half its prey list is on the
    // wrong side of a wall and it spends every hunt padding along the ice
    // looking stupid. Amphibious is exactly the flag for that.
    amphibious: true, eats: ['fish', 'penguin'],
    fights: true, dmg: 6, reach: 1.4, swing: 1.35, aggro: 20,
  }),

  // --- big cats: these have teeth now ---
  // Both are held to a narrow size spread — a big cat that rolled small would
  // read as a dog, and the point of one is that you can tell what it is across
  // a clearing. Neither comes for the player unasked; see the note on `fights`.
  lion: pet('lion', {
    label: 'Lion', h: 1.45, var: 0.10, hp: 14, spd: 1.80, shy: 0.25, turn: 3.4, accel: 8.0,
    diet: 'carnivore', drops: [['hide', 1, 2], ['meat', 1, 2]],
    // Land grazers, and nothing else. A cow is heavier than a lion and stays on
    // the list on purpose — pulling down something bigger than yourself is what
    // a pride is for, and the size check behind this allows it.
    eats: ['deer', 'cow', 'bunny', 'chick', 'monkey'],
    stalks: true,
    fights: true, dmg: 5, reach: 1.3, swing: 1.25, aggro: 16,
  }),
  tiger: pet('tiger', {
    // The largest cat, and it should look it beside a lion, not merely beside a
    // fox. Longest reach and shortest swing of anything that is not a husk.
    label: 'Tiger', h: 1.60, var: 0.10, hp: 14, spd: 1.90, shy: 0.25, turn: 3.6, accel: 8.5,
    diet: 'carnivore', drops: [['hide', 1, 2], ['meat', 1, 2]],
    eats: ['deer', 'cow', 'bunny', 'chick', 'monkey'],
    stalks: true,
    fights: true, dmg: 6, reach: 1.35, swing: 1.15, aggro: 22,
  }),

  // --- middling ---
  dog: pet('dog', {
    // Omnivore rather than carnivore: a dog will chase a chick, but a dog
    // nosing at the grass is a dog, not a broken lion.
    label: 'Dog', h: 0.78, hp: 8, spd: 1.55, shy: 0.4, turn: 4.5, accel: 9.0,
    diet: 'omnivore', graze: 0.2, idleMin: 1.2, idleMax: 3.5, drops: HIDE_MEAT,
    eats: ['chick', 'bunny'],
    fights: true, dmg: 2, reach: 1.0, swing: 1.0, aggro: 16,
  }),
  fox: pet('fox', {
    // Smaller than the dog, which it never was before — both sat at 0.66/0.68
    // and the pair were indistinguishable at any distance.
    label: 'Fox', h: 0.58, hp: 6, spd: 1.45, shy: 0.8, turn: 4.5, accel: 8.0,
    diet: 'carnivore', idleMin: 1.5, idleMax: 4, drops: HIDE_MEAT,
    // No parrot. It was on this list and could never be taken off it: a parrot
    // `flies`, and _findPrey refuses any flier to a hunter that does not, for
    // the reason written out there. A list entry that the gate below it can
    // never admit is worse than no entry — it reads as a fox that hunts birds
    // and produces a fox that does not.
    eats: ['bunny', 'chick'],
    // The bottom of the ladder, and it has to actually be the bottom. At 2 per
    // blow on a 0.85s swing a fox was doing 90% of a husk's damage, which makes
    // the smallest thing that fights you and the thing that hunts you at night
    // the same fight. One point a second is a nuisance you can walk away from
    // mid-bite, which is what a fox is.
    fights: true, dmg: 1, reach: 0.95, swing: 1.0, aggro: 14,
  }),
  cat: pet('cat', {
    // A hunter of chicks and nothing else, and no threat to the player — a cat
    // that fought back would be comedy rather than danger, which is why it gets
    // a diet but no `fights`. That used to leak: predation read `damage ?? 4`,
    // so the one animal here with no damage at all bit prey for twice what the
    // dog does. It is `_preyBite` that decides now, off the prey, and this spec
    // can go on saying nothing about damage — which is what it means.
    label: 'Cat', h: 0.46, hp: 6, spd: 1.60, shy: 0.9, turn: 5.5, accel: 10.0,
    diet: 'carnivore', idleMin: 1.2, idleMax: 4, drops: [['hide', 1, 1]],
    // No bee, for the reason the fox has no parrot — and this is the pairing
    // _findPrey's own flier rule was written about, so the list was left saying
    // something the code had already decided against. A cat still takes chicks
    // and bunnies, which is the whole of what a cat is for here.
    eats: ['chick', 'bunny'],
  }),
  koala: pet('koala', {
    label: 'Koala', h: 0.56, hp: 6, spd: 0.80, shy: 0.5, turn: 2.4, accel: 4.0,
    graze: 0.65, idleMin: 3, idleMax: 8, drops: [['hide', 1, 1]],
  }),
  monkey: pet('monkey', {
    label: 'Monkey', h: 0.68, hp: 6, spd: 1.60, shy: 0.8, turn: 5.0, accel: 9.0,
    graze: 0.35, idleMin: 1, idleMax: 3, drops: [['hide', 1, 1]], hops: true, hopImpulse: 3.6,
    // The only climber on the planet: foliage is floor to a monkey and to
    // nothing else. See `_groundK` for why that is a per-species exception
    // rather than a rule change.
    climbs: true,
  }),
  beaver: pet('beaver', {
    label: 'Beaver', h: 0.5, hp: 6, spd: 1.25, shy: 0.7, turn: 4.0, accel: 7.0,
    graze: 0.45, drops: HIDE_MEAT,
  }),
  penguin: pet('penguin', {
    // Knee-high on the player. Small, but the biggest thing standing upright on
    // the ice apart from the bear, so it is not down with the chicks.
    label: 'Penguin', h: 0.80, hp: 6, spd: 1.10, shy: 0.6, turn: 3.2, accel: 5.5,
    drops: [['poultry', 1, 1], ['feather', 1, 2], ['egg', 1, 1]], cold: true,
  }),

  // --- small and skittish ---
  // Meat is named after the animal it came from, which sounds like a labelling
  // detail and is not: a crab dropping "Raw Meat" was reported as a bug, and it
  // reads as one because a stack of generic meat says the animals are skins on
  // one loot table. `poultry` for anything feathered, `crab_meat` for the crab,
  // `fish` for the fish, `meat` for the large land animals.
  // Everything here is ankle-height and gets a narrow spread: ±12% of a chick
  // is under three centimetres, so the default range buys nothing but noise in
  // the numbers.
  bunny: pet('bunny', {
    label: 'Bunny', h: 0.36, var: 0.06, hp: 4, spd: 1.85, shy: 1.0, turn: 5.0, accel: 9.0,
    graze: 0.35, idleMin: 1, idleMax: 3, drops: HIDE_MEAT, hops: true, hopImpulse: 4.2,
  }),
  chick: pet('chick', {
    label: 'Chick', h: 0.26, var: 0.06, hp: 4, spd: 1.30, shy: 0.85, turn: 6.0, accel: 11.0,
    // The three birds all leave an egg now. It was the merchant's cheapest line
    // and his alone, which meant the whole baking half of the kitchen — every
    // pancake, muffin and croissant — was something you bought rather than
    // something you kept birds for. One per bird, no roll: three species carry
    // it, so the supply is a walk through a meadow rather than a lottery.
    graze: 0.7, idleMin: 0.8, idleMax: 2.4, drops: [['feather', 1, 2], ['poultry', 1, 1], ['egg', 1, 1]],
  }),
  // The parrot flies. It hopped, like a bunny, which is a strange thing for the
  // only other bird on the planet with wings to do — the flight branch already
  // existed for the bee and this is one flag.
  //
  // `hover` was 2.0, chosen against a hard ceiling rather than by eye: a
  // flier's moves were judged by the walking rules, so once its hover put it
  // more than MOB_FALL_FREE (3) layers over the ground every heading cost the
  // refusal value and it stopped moving horizontally altogether. Anything at or
  // above 3 would silently hover in place. That note ended "this coupling is
  // worth removing, and until it is, this number cannot be raised", and then the
  // number was raised to 6.0 — for a good reason, see below — without the
  // coupling being removed.
  //
  // What actually happened is worse than a bird that hovers in place, and is why
  // both halves of this comment were true and the pair of them wrong. The
  // refusal value is 9, i.e. every sample blocked, and `_walkStep`'s escape
  // clause admits any move that costs no *more* than where the body already is
  // — a clause added later, for a deer stuck on a shoreline. So a parrot at 6.0
  // did not hover in place: it had no horizontal collision at all, and flew
  // through cliffs and trunks. Measured before the fix: costHere > 0 on 93% of
  // frames, its centre inside solid rock on 10.9% of them, worst stint 5.2s.
  //
  // The coupling is removed now — a flier is collided as a body in the air (see
  // the flier branch in _colCost) rather than as a walker with a long drop
  // beneath it — so this number is free, and the two comments no longer
  // contradict each other. 6.0 is chosen on the reason below and nothing else.
  parrot: pet('parrot', {
    label: 'Parrot', h: 0.34, var: 0.06, hp: 4, spd: 2.60, shy: 1.0, turn: 6.5, accel: 12.0,
    graze: 0.4, idleMin: 0.8, idleMax: 2.6, drops: [['feather', 1, 3], ['poultry', 1, 1], ['egg', 1, 1]],
    // Height and pace. Two blocks up is head-height on the player, which is
    // why a parrot read as hovering rather than flying — a bird you can reach
    // is a bird that is too low. Six clears the canopy, which is the height a
    // parrot should be seen at, and the speed goes with it: 1.5 was a walk.
    flies: true, hover: 6.0,
  }),
  bee: pet('bee', {
    // "Bees should sting harder" was reported, and the honest answer was that a
    // bee could not sting at all: it had no `fights`, so no damage, no reach and
    // no swing, and swatting one was free. It fights now, and only on the same
    // terms as every other animal here — provoked, never on sight. Coming for
    // you unasked stays the husk's job.
    //
    // Four per sting on a small, fast, 3hp body is deliberately the sharpest
    // damage-to-size ratio in the table. A bee is a burst, not a war of
    // attrition: one connected swing kills it outright, so the only way it hurts
    // you is by landing a sting first, and a sting that cost the same as a fox
    // bite would make the whole exchange beneath notice. Losing a fifth of the
    // bar to something you can barely see is the point. The 1.6s swing and the
    // short reach are what keep it from being a second fight — it gets one good
    // hit in and then it is your turn.
    //
    // Faster than it was, too. At 1.8 it could never close on a player who
    // simply walked (4.4), so the retaliation would have been a threat on paper
    // exactly the way the husk's aggro range once was. That reasoning still
    // holds and the fix has simply moved: it was answered by pushing the wander
    // to 2.6, which made a bee going nowhere in particular the fastest thing on
    // the planet, and is now answered by the chase multiplier. 2.1 × 3.0 = 6.3
    // is the quickest chase in the table and still under a sprint — a bee that
    // you can only shake by running flat out, on 3hp, is exactly the trade the
    // sting is priced at. A wandering bee has slowed down and reads better for
    // it; the darting comes from the 7.0 turn rate, not from the ground speed.
    //
    // The reach looks generous for an insect and is not, because it is the only
    // one in the table measured against a body that is not standing on the
    // ground. `dist` in _hunt runs from the mob's centre to the player's *feet*,
    // and a bee holds station `hover` (1.5) above whatever is underneath it — so
    // even touching the player's face it reads as 1.5 away before any horizontal
    // gap is counted. At a ground animal's reach it could hover inside your head
    // and never once be close enough to swing.
    //
    // And it leaves something behind, which it did not. The bee was the only
    // entry in this whole table with an empty drop list: a fight you could
    // win — on 3hp, having probably been stung for a fifth of your bar getting
    // there — and be paid nothing for. One honeycomb is the payment, and it is
    // the only source of the only sweetener on the planet, so the entire treat
    // tier in `Recipes.js` hangs off this one line.
    label: 'Bee', h: 0.26, var: 0.06, hp: 3, spd: 2.10, shy: 1.0, turn: 7.0, accel: 14.0,
    graze: 0.5, idleMin: 0.6, idleMax: 1.8, flies: true, hover: 1.5,
    drops: [['honeycomb', 1, 1]],
    fights: true, dmg: 4, reach: 2.0, swing: 1.6, aggro: 12,
  }),
  crab: pet('crab', {
    // Amphibious and shore-bound. It used to be an ordinary land animal, which
    // put crabs in the middle of deserts (the desert table listed them, because
    // sand is sand) and made a puddle an impassable wall to the one animal on
    // the planet that lives in the surf. Both flags are read by the movement
    // code — see the water rule in _footprintCost and _shoreBearing.
    label: 'Crab', h: 0.30, var: 0.06, hp: 5, spd: 1.15, shy: 0.7, turn: 5.0, accel: 8.0,
    graze: 0.4, drops: [['crab_meat', 1, 1]], amphibious: true, shore: true,
  }),
  caterpillar: pet('caterpillar', {
    label: 'Caterpillar', h: 0.22, var: 0.06, hp: 3, spd: 0.55, shy: 0.6, turn: 2.5, accel: 4.0,
    graze: 0.8, idleMin: 2, idleMax: 6,
  }),
  /**
   * One species, many faces.
   *
   * `urls` has always been a list the spawner draws a variant from — the husk
   * uses it for two bodies — so a shoal of clownfish, tangs, koi and tetras
   * costs no new spawn logic, no new budget and no new save field. What used to
   * be a single generic fish is now whichever of these the seed picked, and it
   * stays that fish across a reload because the variant is drawn from the same
   * seeded stream.
   *
   * The pack is skinned, unlike every animal before it, which is what made
   * `MobModels.instantiate` need a real skeleton clone.
   */
  fish: {
    ...pet('fish', {
      label: 'Fish', h: 0.40, var: 0.10, hp: 4, spd: 1.50, shy: 0.9, turn: 4.5, accel: 8.0,
      graze: 0.3, idleMin: 1, idleMax: 3, drops: [['fish', 1, 1]], aquatic: true,
    }),
    urls: FISH_KINDS.map(FISH),
    clips: FISH_CLIPS,
  },
  /**
   * The deep water, which until now held exactly the same fish as a pond.
   *
   * Gated on depth at the spawn rather than on biome: the ocean shelf is the
   * same biome as the abyss beside it, and what decides whether an anglerfish
   * belongs is how far down the bed is, not what the map calls it.
   */
  deep_fish: {
    ...pet('fish', {
      label: 'Fish', h: 0.55, var: 0.14, hp: 6, spd: 1.30, shy: 0.9, turn: 4.0, accel: 7.0,
      graze: 0.2, idleMin: 1, idleMax: 4, drops: [['fish', 1, 1]], aquatic: true,
    }),
    urls: DEEP_KINDS.map(FISH),
    clips: FISH_CLIPS,
  },
  /**
   * Something that eats the shoal.
   *
   * `eats` is the same data the lions and tigers use, so nothing new is needed
   * to make it hunt — a predator that happens to be aquatic hunts down the same
   * path as one that walks. It is deliberately not `fights`: a shark chases
   * fish, not you. Swimming into one should be unwise, not a death sentence
   * delivered from across the bay.
   */
  shark: {
    ...pet('fish', {
      label: 'Shark', h: 1.5, var: 0.12, hp: 20, spd: 1.85, shy: 0.2, turn: 3.4, accel: 8.0,
      // A third rather than the bear's quarter, because both entries in `eats`
      // below are fish: a bear splits its diet with penguin, a shark does not
      // eat anything else at all. Still under a half so a shark reads as meat
      // and hide with a fish in it, and at 0.89 bulk it is one fish, not a
      // haul.
      graze: 0, idleMin: 1, idleMax: 3, drops: [['meat', 1, 2], ['hide', 1, 1], ['fish', 1, 1, 0.35]],
      aquatic: true, diet: 'carnivore', eats: ['fish', 'deep_fish'],
    }),
    urls: [FISH('shark')],
    clips: FISH_CLIPS,
  },
  piranha: {
    ...pet('fish', {
      label: 'Piranha', h: 0.45, var: 0.10, hp: 6, spd: 1.95, shy: 0.3, turn: 5.0, accel: 9.0,
      graze: 0, idleMin: 0.6, idleMax: 2, drops: [['fish', 1, 1]],
      aquatic: true, diet: 'carnivore', eats: ['fish'],
    }),
    urls: [FISH('piranha')],
    clips: FISH_CLIPS,
  },

  // --- the things that want you dead in broad daylight ---
  //
  // Rare, and each one belongs somewhere: see MONSTER_BY_BIOME. Sizes are in
  // cells against a player of 1.8, so a cyclops looms and a mushroom does not.
  yeti: monster('yeti', {
    label: 'Yeti', h: 2.3, hp: 26, spd: 1.15, shy: 0, turn: 3.0, accel: 6.5,
    dmg: 7, reach: 1.8, swing: 1.7, aggro: 15, drops: [['hide', 1, 2]],
  }),
  cyclops: monster('cyclops', {
    label: 'Cyclops', h: 2.6, hp: 30, spd: 1.05, shy: 0, turn: 2.6, accel: 6.0,
    dmg: 8, reach: 2.0, swing: 1.9, aggro: 14, drops: [['hide', 1, 2], ['cinder', 1, 1]],
  }),
  demon: monster('demon', {
    label: 'Demon', h: 1.9, hp: 22, spd: 1.35, shy: 0, turn: 3.6, accel: 8.0,
    dmg: 6, reach: 1.5, swing: 1.2, aggro: 15, drops: [['cinder', 1, 2]],
  }),
  greendemon: monster('greendemon', {
    label: 'Imp', h: 1.5, hp: 16, spd: 1.45, shy: 0, turn: 4.2, accel: 8.5,
    dmg: 4, reach: 1.3, swing: 1.1, aggro: 14, drops: [['cinder', 1, 1]],
  }),
  skull: monster('skull', {
    label: 'Skull', h: 1.6, hp: 18, spd: 1.30, shy: 0, turn: 3.8, accel: 8.0,
    // `bone` was the obvious drop and does not exist — `itemIdOf` would have
    // returned 0 and the skull would have dropped nothing, silently, forever.
    dmg: 5, reach: 1.4, swing: 1.2, aggro: 14, drops: [['flint', 1, 2], ['sulfur', 1, 1]],
  }),
  alien: monster('alien', {
    label: 'Alien', h: 1.7, hp: 20, spd: 1.40, shy: 0, turn: 4.0, accel: 8.5,
    dmg: 5, reach: 1.4, swing: 1.2, aggro: 15, drops: [['crystal', 1, 1]],
  }),
  alien_tall: monster('alien_tall', {
    label: 'Tall Alien', h: 2.2, hp: 24, spd: 1.25, shy: 0, turn: 3.2, accel: 7.0,
    dmg: 6, reach: 1.7, swing: 1.5, aggro: 16, drops: [['crystal', 1, 2]],
  }),
  cactus_monster: monster('cactus', {
    label: 'Prickler', h: 1.6, hp: 18, spd: 1.10, shy: 0, turn: 3.0, accel: 6.0,
    dmg: 5, reach: 1.4, swing: 1.4, aggro: 12, drops: [['cactus', 1, 2]],
  }),
  mushroom_monster: monster('mushroom', {
    label: 'Sporeling', h: 1.2, hp: 14, spd: 1.20, shy: 0, turn: 4.0, accel: 7.5,
    dmg: 3, reach: 1.2, swing: 1.1, aggro: 12, drops: [['mushroom', 1, 3]],
  }),
  // --- and the ones with wings ---
  //
  // `hover` has to sit *inside* `reach`, and that is not obvious until you
  // watch one try. A flier holds station at `hover` above the ground while
  // the contact test measures straight-line distance to a player standing on
  // it, so a bat hovering at 2.6 with an effective reach of 1.82 was
  // permanently outside its own range: measured at one hit in two hundred
  // seconds, against a cyclops that kills in six. The dragon had the same
  // fault more mildly and took eleven seconds to land three blows worth nine
  // each. Every hover here is now comfortably under the reach beside it.
  bat: monster('bat', {
    label: 'Bat', h: 0.7, hp: 8, spd: 1.90, shy: 0, turn: 5.5, accel: 10.0,
    dmg: 2, reach: 1.2, swing: 0.9, aggro: 12, flies: true, hover: 1.2,
    drops: [['hide', 1, 1]],
  }),
  cthulhu: monster('cthulhu', {
    label: 'Cthulhu', h: 1.9, hp: 26, spd: 1.55, shy: 0, turn: 3.4, accel: 8.0,
    dmg: 7, reach: 1.7, swing: 1.5, aggro: 16, flies: true, hover: 2.0,
    drops: [['crystal', 1, 2]],
  }),
  dragon: monster('yellowdragon', {
    label: 'Dragon', h: 2.1, hp: 34, spd: 1.75, shy: 0, turn: 3.0, accel: 8.5,
    dmg: 9, reach: 1.9, swing: 1.8, aggro: 18, flies: true, hover: 2.4,
    drops: [['cinder', 2, 3], ['gold_ingot', 1, 2]],
  }),
  ghost: monster('ghost', {
    label: 'Ghost', h: 1.6, hp: 14, spd: 1.60, shy: 0, turn: 4.4, accel: 9.0,
    // "The ghost looks dark grey instead of white." It was lit like flesh, and
    // a ghost is not flesh. Everything else in the roster stays on the scene
    // lights, whose night floor is solved at 0.17 through the tone-mapping pass
    // and must not be raised - the comment in `Sky.js` records that above it the
    // whole roster starts glowing, which is the bug that constant was born to
    // fix. So this is one mob carrying its own light rather than the world
    // being brightened for it.
    glow: 0.55,
    dmg: 4, reach: 1.4, swing: 1.2, aggro: 14, flies: true, hover: 1.8,
    // Drifts, but is animated as a walker — the pack gave it the ten-clip rig,
    // not the four-clip flying one.
    flyAnim: false,
    drops: [],
  }),

  // --- the one thing that wants you dead ---
  husk: {
    label: 'Husk', urls: [CHAR('l'), CHAR('o')], clips: CHAR_CLIPS, height: 1.72,
    // 1.50 put a chasing husk at 1.50 x CHASE_SPEED = 4.5 cells/s against a
    // player who walks at 4.4 — it matched your pace exactly, so walking away
    // was not an option and the only answer to one was to turn and fight or
    // burn stamina. At 1.28 the chase is 3.84, comfortably under a walk: you
    // can always leave, but you cannot dawdle, and outrunning one still costs
    // you the ground you were standing on. The cap went up to pay for it.
    health: Math.round(14 * HOSTILE_HP), speed: 1.28, skittish: 0, turn: 3.2, accel: 6.0,
    // Cinder is the whole reason to be outside after dark; roughly every other
    // husk carries one, so a good night funds part of a cinder tool.
    drops: [['flint', 0, 1], ['coal', 0, 1], ['cinder', 0, 1]],
    grazeChance: 0, idleMin: 1.5, idleMax: 3.5,
    // --- what makes it a threat ---
    hostile: true,
    damage: 3,            // half-hearts per blow
    reach: 1.25,          // cells between body centres to land one
    swing: 1.15,          // seconds between blows
    // Must exceed SPAWN_MIN_DIST, or a husk can never notice the player it
    // spawned for. At 16 against a spawn ring starting at 20, every one of them
    // arrived already out of range and wandered off: a player could stand in
    // the open through a whole night with the full cap of seven around them and
    // take no damage at all. Night had threat on paper and none in play.
    aggroRange: 34,       // cells it will notice you from
    burns: true,          // direct daylight sets it alight
  },

  // --- the one thing that is only ever seen ---
  //
  // Written out as a literal rather than through `pet()`, for the reason the
  // husk and the merchant are: those builders copy only the fields they have
  // been told about, and a `phantom: true` handed to `pet()` would be dropped
  // on the floor without a word. Everything this thing is depends on flags, so
  // there is nothing here for a builder to save.
  //
  // `urls` is the fallback body only. He wears whichever character the player
  // chose — that is the entire idea, "a herobrine version of ourself" — and
  // spawn() takes `this.playerModel` for it when main has set one. The default
  // character is listed here so MOB_MODEL_URLS preloads *something* and the
  // spawn can never be the thing that discovers the model is missing.
  stalker: {
    label: 'Stalker', urls: [CHAR('a')], clips: CHAR_CLIPS,
    // Exactly the player's 1.8, and no size variance. Every other species is
    // jittered per head so a herd does not look stamped; this one is meant to
    // look stamped. It is meant to look like you.
    height: 1.8, sizeVar: 0,
    // Health is a formality — `phantom` turns away every path into _damage and
    // hurt() — but a spec with no health at all would put NaN into a dozen
    // comparisons the moment someone forgets one of those guards.
    health: 1,
    // The wander pace, which is only ever used at the walk-away: at
    // CHASE_SPEED it would be 6.9, past the player's sprint, and a figure that
    // outpaces a sprinting player is a thing you are losing a race to rather
    // than a thing that is leaving. He does not need to be faster than you.
    // He needs to be gone, and STALKER_VANISH is what makes that certain.
    speed: 1.55, skittish: 0, turn: 2.4, accel: 5.5,
    drops: [],                  // and `phantom` means _die is never reached anyway
    grazeChance: 0, idleMin: 2, idleMax: 5,
    // --- what makes him a sighting ---
    phantom: true,
    /**
     * How much of the texture survives. 0.10 is dark enough to read as a
     * silhouette against grass in daylight and as an absence against the sky
     * at night, while leaving just enough of the atlas to tell that it is a
     * person wearing what you are wearing.
     *
     * Applied as a multiply into `color` on the per-mob material clones spawn()
     * already makes, which is the one safe way to touch these materials: the
     * map object is passed around untouched and nothing is re-uploaded. See the
     * note in `lit()` for what happens to anything that is not that.
     */
    shade: 0.10,
    eyes: true,
  },

  // --- the one thing on the planet that will talk to you ---
  merchant: {
    label: 'Wandering Merchant', urls: [CHAR('d')],
    // The Blocky Characters rig again, but the emote stands in for grazing:
    // an animal chewing and a trader waving are the same slot in the state
    // machine, and it is the only clip that reads as "person" at distance.
    clips: { ...CHAR_CLIPS, graze: 'emote-yes' },
    height: 1.72,
    // Not a fight anyone should win by accident. It is also the only mob a
    // player has a reason to keep alive, so it is built to survive a stray
    // swing rather than to be farmed.
    health: 60, speed: 1.10, skittish: 0, turn: 2.6, accel: 5.0,
    drops: [['coin', 2, 6]],
    // Short pauses and a long walk phase: it should always be going somewhere,
    // because a merchant standing still is a shop, and this is a chance meeting.
    grazeChance: 0.2, idleMin: 0.6, idleMax: 1.8,
    trader: true,       // carries stock, opens the shop, never flees
    lamp: true,         // a warm point of light, so you can spot one at dusk
  },
};

/**
 * How often a species is drawn from its biome's list, against the others on it.
 *
 * "Bigger animals should be more rare", and the honest way to do that is a
 * weight on the draw rather than a special case at the two or three places a
 * giant is listed. The biome tables stay what they are — the record of what
 * lives where, with repetition meaning "common" — and this only ever makes
 * something *rarer*, which is why it is clamped at 1 at the small end: a bunny
 * is common because the meadow list says bunny twice, not because it is small.
 *
 * Derived from height for the same reason the other two size curves are: one
 * statement of how big a thing is, in the table, and everything else read off
 * it. A steeper exponent than the loot and knockback curves, because rarity is
 * the one of the three that is meant to be felt as a step change.
 *
 *   deer 1.50, lion 1.45, cow 1.62   1.00   the ordinary run of the table
 *   polar bear 1.90                  0.69
 *   elephant 3.05                    0.25
 *   giraffe 3.90                     0.15
 *
 * On the savanna list — giraffe, giraffe, elephant, lion, tiger, deer — that
 * turns a flat one-in-six for an elephant into one in fourteen, and a giraffe
 * from a third of every spawn into a twelfth. Meeting one is an event again.
 */
const SPAWN_REF_H = 1.6;
const SPAWN_RARE_POW = 2.2;
const SPAWN_RARE_MIN = 0.10;
for (const spec of Object.values(SPECIES)) {
  spec.spawnWeight = clamp(
    Math.pow(SPAWN_REF_H / Math.max(0.05, spec.height), SPAWN_RARE_POW), SPAWN_RARE_MIN, 1,
  );
}

// --- husbandry ---------------------------------------------------------------

/** Anything a grazer will take from your hand. */
const FEEDS = new Set(['wheat', 'seeds', 'apple'].map(itemIdOf).filter(Boolean));
/** Centre + 8 perimeter samples, as unit offsets scaled by the body radius. */
const D8 = Math.SQRT1_2;
const FOOT_OFF = [
  0, 0,  1, 0,  -1, 0,  0, 1,  0, -1,
  D8, D8,  D8, -D8,  -D8, D8,  -D8, -D8,
];

// --- predation ---------------------------------------------------------------
// Carnivores hunt the herd, not just the player. Every number here exists to
// stop that eating the planet: a carnivore only looks while it is hungry, rests
// for the best part of a minute after each kill *and* after each failed chase,
// and its prey search is one pass over this.list — which the manager caps at
// MAX_MOBS — on a timer rather than every frame. At the caps that is a few
// dozen distance tests a second for the whole world.
//
// Nothing here can empty a biome: the spawn tick backfills wildlife towards
// MAX_WILDLIFE every SPAWN_PERIOD from the biome table, so an eaten bunny is
// replaced by another of whatever lives there long before a predator is hungry
// again.
// Hunts also succeed far more often than they used to, and that is on purpose:
// a chase at CHASE_SPEED genuinely runs down a bolt at FLEE_SPEED, where before
// a cow fleeing at 1.7 was faster than the tiger chasing it at 1.5 and kills
// landed only when the flee state happened to lapse. Nothing needed rebalancing
// for it, because the rest below — not the chase — is what caps the kill rate:
// a carnivore eats at most once per PREY_REST, however good it is at catching.
const PREY_PERIOD = 1.6;      // seconds between prey searches for one carnivore
/**
 * Seconds a hunter must wait between two bites of the same hunt.
 *
 * Without this the bite is per-frame while the prey is in reach, and telling
 * the prey to flee is not enough to separate them: at 0.05s a tick a bolting
 * deer has moved 0.15 cells, still well inside `reach`, so the second bite
 * lands on the next tick. Two bites 0.1s apart is arithmetically not a
 * one-shot and visually exactly one — which is what was still being reported
 * after the bite replaced the outright deletion. The cooldown is what actually
 * puts the chase between the bites.
 */
const BITE_PERIOD = 1.5;
const PREY_RANGE = 20;        // cells it will notice something to eat from
const PREY_GIVE_UP = 12;      // seconds of chasing before it loses interest
const PREY_REST_MIN = 34;     // seconds after a kill before it hunts again
const PREY_REST_MAX = 70;
/**
 * How tall prey may be as a fraction of the hunter's own height.
 *
 * This is the *second* filter now, not the first — `eats` on the spec says what
 * a species hunts and this only says whether this particular individual is a
 * plausible size for it. So it is loose rather than tight: a lion is on the
 * list for a cow, and a cow is taller than a lion, because pulling down
 * something bigger than yourself is what a big cat is for. What it still stops
 * is a runt of one species taking a giant of another after both have rolled
 * their size jitter and the hunter's prey has eaten its way up GROW_MAX.
 */
const PREY_SIZE = 1.5;

// --- the other half of predation: prey that can see it coming ----------------
//
// Everything above this is the hunter's side. The prey's side, until now, was a
// single line inside _stalk: the hunter tells the animal it has already chosen
// to run. That is awareness of *being hunted*, which is not the same thing as
// awareness of a predator, and the difference is the report — "deer not getting
// away from the tiger doesn't make sense". A tiger that has eaten is resting off
// PREY_REST and never picks anyone, so nobody is ever told anything, and a deer
// grazes at its elbow for a minute.
//
// So prey gets a sense of its own. Three rules shape it:
//
//   1. It is about presence, not intent. A predator standing there is enough.
//      Nothing here reads `hungerT` or `prey` — that is exactly the coupling
//      that produced the bug.
//   2. The threat is measured with what the species table already says: can
//      this thing physically take me (the PREY_SIZE ceiling _findPrey uses),
//      am I actually on its list, and how hard does it hit (`damage`). There
//      is no threat table, because a second table would drift from the first.
//   3. It has to settle. An animal that cannot escape stops trying and stands
//      there warily rather than vibrating, and an animal that has escaped does
//      not turn round at the boundary and come back — hence SPOOK_CLEAR and
//      SPOOK_REST.
//
// Cost. This is a scan by *every* prey animal, which is the thing the hunt
// scan's own comment warns about, so it is inverted: once per THREAT_PERIOD the
// manager makes one pass over this.list and keeps the handful of bodies that
// could threaten anything at all (`this._threats` — carnivores, omnivores and
// husks, typically under ten of the 134). Each prey animal then looks at that
// short list on its own jittered SPOOK_PERIOD clock. The whole system is
// therefore O(n) twice a second plus O(n·k/SPOOK_PERIOD) with k ≈ the number of
// predators alive, not O(n²) per frame. Measured at a full roster it is a few
// microseconds a frame; see the harness note in the change description.
/** Seconds between rebuilds of the planet's shared threat list. */
const THREAT_PERIOD = 0.5;
/** Seconds between one prey animal's looks around it (jittered ±20%). */
const SPOOK_PERIOD = 0.75;
/**
 * The comfort ring, in cells, before scaling: what a zero-damage predator would
 * get, and the per-half-heart slope on top of it. A tiger (6) comes out at 8.4
 * cells before the size factor, a lion (5) at 7.5, a fox (1) at 3.9 — which is
 * the graded response the report asks for, taken straight off the damage ladder
 * rather than off a new number per species.
 */
const SPOOK_BASE = 3.0;
const SPOOK_PER_DMG = 0.9;
/**
 * And a ceiling, because the ring is also the distance a hunt has to close.
 * PREY_RANGE * 0.55 = 11 is where a committed hunt starts driving its target
 * anyway, so nothing gains from a ring wider than that: past it the prey would
 * be reacting to an animal the hunt has not even noticed.
 */
const SPOOK_MAX = 10;
/** Relative size, as a multiplier on the ring. A tiger over a bunny, not a deer. */
const SPOOK_SIZE_MIN = 0.6;
const SPOOK_SIZE_MAX = 1.6;
/**
 * What a predator that could take you but does not have you on its list is
 * worth. A tiger does not eat pandas, and a panda grazing at its feet is the
 * same picture the report complained about — but half a ring, not a whole one,
 * because it is wariness rather than being dinner.
 */
const SPOOK_UNLISTED = 0.5;
/** Unease needed to actually move. Filled at (0.3 + depth into the ring)/s. */
const SPOOK_TRIGGER = 1.0;
const SPOOK_FILL = 0.3;
/** ...and drained at this a second once the ring is clear. */
const SPOOK_DECAY = 0.9;
/**
 * Hysteresis. It runs until it is a third clear of the ring, not until it is
 * exactly on the edge — a herd that stops the instant the test flips spends the
 * next minute stepping in and out of it, which is the oscillation the report
 * would have complained about next.
 */
const SPOOK_CLEAR = 1.35;
/** Well inside the ring: skip the build-up, go. Also the only bypass of SPOOK_REST. */
const SPOOK_PANIC = 0.8;
/** Longest one bolt lasts before the animal either has escaped or gives up. */
const SPOOK_HOLD = 6;
/**
 * And the wary pause afterwards. The long one is for an animal that could not
 * get away: it stops, because a deer pinned in a corner that keeps sprinting
 * into the same wall reads far worse than a deer that has frozen. Being
 * genuinely hunted overrides it — see the `hunted` test in _spook.
 */
const SPOOK_REST = 7;
const SPOOK_REST_VAR = 3;
/** ...and the short one, for an animal that simply got clear. */
const SPOOK_EASE = 1.5;
/**
 * The herd cue: one animal bolting is a reason for its neighbours to look up.
 * Deliberately worth less than a trigger on its own, so alarm cannot propagate
 * on its own account and turn the planet into a standing wave — it only tips
 * over an animal that was already uneasy, which in practice means one that is
 * inside the same predator's ring and a second or two behind its neighbour.
 * The list is a handful of entries that expire after ALARM_LIFE.
 */
const ALARM_LIFE = 1.5;
const ALARM_RANGE = 7;
const ALARM_WEIGHT = 0.55;
const ALARM_MAX = 24;
/** Seconds an alarm-only bolt runs for, when the caller cannot see the threat itself. */
const ALARM_BOLT = 1.6;

/**
 * A kill makes a predator bigger, permanently. Five good ones take it to the
 * ceiling and no further — an old tiger should be a landmark, not a mountain —
 * and its drops scale on exactly the same curve, so a fully grown one is worth
 * twice what a fresh one is.
 */
const GROW_PER_KILL = 0.06;
const GROW_MAX = 1.30;
const LOOT_MAX = 2.0;

/**
 * And the other half of "animals should have scaled loots": size in general,
 * not only the size a predator ate its way to.
 *
 * The drop lists are written per species and they had converged on the same
 * one or two of everything, so a giraffe — nearly eleven times a bunny's
 * height — was worth the same hide as the bunny, and an elephant one extra.
 * Butchering the largest animal on the planet has to be worth the walk home.
 *
 * Off the drawn height again, on the same reasoning as knockMass, and using
 * the individual's `baseHeight` so its size jitter counts. The exponent sits
 * between length and volume: at a true cube a giraffe would drop thirteen
 * cows' worth of hide and the tanning rack would never need another one.
 *
 *   chick   0.26   0.60x (clamped)   still its one feather and one poultry
 *   bunny   0.36   0.60x (clamped)
 *   fox     0.58   0.21 -> 0.60x
 *   cow     1.62   1.00x             the reference: unchanged, 1-2 of each
 *   polar   1.90   1.27x
 *   elephant 3.05  2.58x             5-8 hide, 5-8 meat
 *   giraffe  3.90  3.72x             4-7 of each off a 1-2 list
 *
 * The floor is 0.6 rather than something smaller because Math.round takes 0.6
 * back up to 1: it keeps the small end exactly where it was rather than
 * quietly turning a chick into nothing, which would make the smallest animals
 * not worth hitting at all.
 */
const LOOT_REF_H = 1.62;
const LOOT_BULK_POW = 1.5;
const LOOT_BULK_MIN = 0.6;
const LOOT_BULK_MAX = 4.0;
const lootBulk = (h) => clamp(
  Math.pow(Math.max(0.05, h) / LOOT_REF_H, LOOT_BULK_POW), LOOT_BULK_MIN, LOOT_BULK_MAX,
);

/** Seconds of the scale pop that stands in for a missing attack clip. */
const LUNGE_TIME = 0.3;

// --- the night stalk ---------------------------------------------------------
// The one time an animal comes for the player unasked, and every number here
// exists to keep it an event rather than a rule. It is night-only, hungry-only,
// big-cats-only, and it announces itself for six seconds before it means
// anything — the complaint that removed unprovoked aggression everywhere else
// was not "a tiger attacked me", it was being attacked with no idea why.
//
// The tell has to be built out of movement and sound: Cube Pets ships no attack
// clip and no growl pose, so there is nothing to play. What it does instead is
// walk. A creeping approach at half speed, holding at a body-length or three
// with its eyes on you and calling, is a completely different silhouette from
// the flat-out run every other chase in this file uses, and it is legible at
// night because it is slow. Six seconds is long enough to draw a weapon, put a
// wall between you, or simply leave.
const PROWL_PERIOD = 8;       // seconds between the *planet's* chances to start one
// Per check, world-wide. It was 0.05 and it was rolled by each cat on its own
// clock, and both halves of that were wrong. This is the "a lion just attacked
// me unprovoked" report, and it is the same complaint the `fights` note above
// records — the stalk was not the old behaviour under a new name when it was
// written, but at this rate it had become it.
//
// The first half is arithmetic that was started and not finished. 0.05 per 8s
// is a mean of 8 / 0.05 = 160 seconds of exposure, which is what the old
// comment said, and it stopped there as though 160 seconds were a long time.
// It is not, because night here is not a compressed cycle: `dayMinutes`
// defaults to 0, which puts the planet on the device clock and makes a night
// twelve real hours long. A player who sits down after dark is eligible for the
// whole session, and half an hour of that is 1800 / 160 = eleven stalks off a
// single lion.
//
// The second half is that N cats ran N independent clocks, so the rate the
// *player* met was 160 / N, and the biome tables make N routine rather than
// exceptional — BADLANDS is ['lion', 'tiger', 'caterpillar'], two thirds big
// cat, and SAVANNA carries two of seven. Four in the ring is one stalk every
// forty seconds. No telegraph rescues that: a tell you see twenty times an hour
// is not a tell, it is the weather, and the player stops reading it as "this
// one has decided about me" long before it commits.
//
// So the roll moved off the animal and onto the planet (see the clocks in the
// constructor, the tick in update, and _prowl), which makes the rate
// independent of how many cats happen to be standing about, and the chance was
// rescaled against real exposure instead of an imagined short night:
// 8 / 0.005 = 1600 seconds, about twenty-seven minutes of eligible night, and
// PROWL_REST on top of each one. One or two in a long evening, which is what
// "rare" was always meant to mean.
//
// Rejected: capping the number of big cats a biome may spawn. It fixes the
// arithmetic by emptying the savanna, and the population is the ecology.
// Rejected: only letting the *nearest* cat roll. Still one roll per period per
// player, but it silently makes the rate depend on the herd geometry again the
// moment two cats are equidistant, and it is a longer way round to the same
// place this took.
const PROWL_CHANCE = 0.005;
/** Seconds before the planet will consider another stalk.
 *
 *  Also what stops two cats converging on you at once, which the per-animal
 *  roll allowed and which no telegraph can carry: one cat walking you down is
 *  an event, two is an ambush, and an ambush is the unprovoked-aggression
 *  complaint again with better staging. */
const PROWL_REST = 240;
const PROWL_RANGE = 26;       // cells it will consider you from
const PROWL_HOLD = 6.5;       // cells it closes to, then waits at
const PROWL_TELL = 6;         // seconds of telegraph before it commits
const PROWL_GROWL = 1.7;      // seconds between calls while telegraphing
/** How much of its walk a creeping cat uses. Slow enough to read as stalking. */
const PROWL_SPEED = 0.5;

// --- shorelines ---------------------------------------------------------------
/** The eight compass directions as column offsets, for the water search. */
const RING8 = [1, 0, 1, 1, 0, 1, -1, 1, -1, 0, -1, -1, 0, -1, 1, -1];
const SHORE_STEP = 2;    // columns between samples along a direction
const SHORE_NEAR = 4;    // this close to water counts as being on the shore
const SHORE_PULL = 16;   // and this far is as far as one will look for it

// --- a land animal in the drink ----------------------------------------------
// The other half of the shoreline, and the flags it is *not*: `aquatic` is "the
// water is the only place I go", `amphibious` is "the water is not a wall".
// Neither describes a deer that has been knocked into a river, which wants
// nothing to do with the water and has to get out of it — so it is a condition
// the body is in rather than a species trait, and it is read off the block
// under the animal every frame instead of off the spec.
/** How high in the surface layer a floating body rides, in cells. */
const WADE_RIDE = 0.25;
/**
 * ...and where standing in water stops and being in the drink begins.
 *
 * "Husks are not chasing me in water" — and they were not, at any depth at all,
 * because two rules together made every wet column on the planet a wall to
 * anything that walks:
 *
 *   1. `_footprintCost` (and `_stepTo` behind it) treated liquid as solid for
 *      any land body, with an exemption for one that is already `wading`. That
 *      exemption cannot be reached from dry land — `wading` is only true of a
 *      body that is *in* the water — so a walker could be in water it had been
 *      knocked into and could never choose to enter any. A husk stopped dead at
 *      the water line of a puddle.
 *   2. `wading` itself meant "touching water", so the moment a body did end up
 *      in an inch of it, the get-out-of-the-water override took the frame: it
 *      floated at WADE_RIDE, dropped to a paddle, forgot what it was doing and
 *      swam for the bank.
 *
 * Between them, standing in water was a complete defence against the one thing
 * on this planet that comes for you unasked — and, with the door fault above,
 * the second of two ways to make the night stop applying by standing somewhere.
 * That is a bigger change to what a torch is worth than any number in this file.
 *
 * The line drawn here is depth, and it is drawn per body rather than as a
 * constant, because "can I stand up in this" is a question about the animal:
 * a husk is 1.72 and a chick is 0.26, and one number cannot mean the same thing
 * to both. Water no deeper than WADE_STAND of the body's drawn height is
 * something it stands in — feet on the bed, walking, hunting, footprint rules
 * exactly as on land, and no more special than tall grass. Deeper than that it
 * is out of its depth: it floats, it wants the bank, and everything the swim
 * code already does takes over unchanged.
 *
 * 0.72 puts the line for a husk at 1.24 cells, i.e. it will walk into a
 * one-block ford or shallows and not into a two-block channel — chest-deep on
 * it, head clear. For the wildlife the effect is almost nothing, which is the
 * point of scaling it: at one block of water the only species tall enough to
 * wade are the ones a player would expect to (cow, deer, lion, tiger, polar,
 * husk and up), and a chick still treats a puddle as a wall. The ceiling stops
 * a giraffe deciding a four-deep river is a paddle.
 *
 * Deep water therefore stays a refuge, and that is deliberate: _hunt already
 * holds a hostile on the bank when the player is genuinely swimming (see
 * `_playerAfloat`), and the two lines now agree instead of one of them being
 * unreachable. What is no longer a refuge is ankle depth.
 */
const WADE_STAND = 0.72;
/** ...and the most water anything walks into, however tall it is. */
const WADE_STAND_MAX = 2.0;
/**
 * How far above itself a floating body may haul itself out onto, in cells.
 *
 * The one number that says what "getting out of the water" means, and it is
 * deliberately used in two places that had drifted apart: the footprint test
 * decides whether a wet body may move over a piece of bank, and the floor clamp
 * decides whether it is then lifted onto it. Those two have to be the same
 * question or the body walks to the edge of ground it is never raised onto,
 * which is exactly the reported tiger — sliding along a bank at swimming speed
 * with the run clip playing, forever.
 *
 * 2.0 against a body riding at `waterTop + WADE_RIDE` reaches ground whose top
 * is one block above the water surface, and stops short of two. A bank you can
 * see over is a bank you can climb; a wall twice your own head height is a
 * cliff, and `_landBearing` refuses to swim at one for the same reason.
 *
 * It is a *reach*, measured from where the body actually is, not a step rule
 * measured from a layer index. That is what keeps a body which has been driven
 * under — knocked in, or still sinking — from being allowed onto a bank it is
 * four layers below and then teleported up onto it.
 */
const WADE_CLIMB = 2.0;
/**
 * ...and how much further a body that has been stuck may reach.
 *
 * The same escape licence the step rules get (see ESCAPE_RISE), applied to the
 * one rule that decides whether a floating body can get out of the water at
 * all. A tiger knocked into a lake whose banks all stand two blocks proud is
 * refused by WADE_CLIMB on every heading, correctly — that is a cliff — and
 * then has nowhere to go: 76% of bodies knocked into water in the census were
 * still within two units of where they landed three minutes later.
 *
 * Read through `_haulReach` by both the footprint test and the floor clamp,
 * because those two have to be asking the same question. They were written out
 * separately once before and drifted, and the animal in between them swam at a
 * bank it was never permitted to touch.
 */
const WADE_ESCAPE = 2.0;
/** Columns it will look for a bank, and how often it looks. */
const SWIM_LOOK = 14;
const SWIM_PERIOD = 0.6;
/** How hard it swims, as a multiple of its wander. Not a bolt; a determined paddle. */
const SWIM_SPEED = 1.5;
/**
 * And how fast the walk clip plays while it does — see the gait in _animate.
 *
 * Slow enough to read as effort against water rather than as a stroll, and the
 * only number in the animation block that is not a ratio of a ground speed,
 * because there is no ground.
 */
const WADE_CLIP_RATE = 0.55;
/**
 * Looks at the bank that come back with nothing before a swimmer stops trying
 * to land and starts following the shore instead.
 *
 * Two, so a single bad reading — a bank that happened to be behind a body it
 * was drifting past — cannot change what the animal is doing, and 1.2 seconds
 * is short enough that a lake with one way out is still found promptly.
 *
 * The case this exists for is a lake whose banks all stand two or more blocks
 * over the water line. `_landBearing` correctly refuses every one of them —
 * that is a cliff, and raising the limit so a body could climb it would let
 * every animal on the planet climb walls — so it returns null, and the wading
 * branch used to answer null by holding whatever heading it already had. Which
 * is the heading it was swimming at the bank on. Measured on a ringed lake:
 * the deer reached the rim in 1.6s and then spent the remaining 28 seconds
 * pressed against it, 0.1 cells of ground covered, at a full determined
 * paddle. Nothing about that is escape and all of it is visible.
 */
const SWIM_GIVE_UP = 2;
/**
 * How fast it follows the shore once it has given up on climbing out, as a
 * multiple of its wander. Under SWIM_SPEED because this is no longer a body
 * striking out for anywhere: it is a body keeping to the edge, which is what a
 * real animal in a walled pool does and, more to the point, is a thing that
 * looks like a decision rather than like a broken one.
 */
const SWIM_CIRCLE = 0.9;

// --- getting unstuck ---------------------------------------------------------
//
// Everything above this point is a rule about where a body may go, and every
// one of them is a rule about *this* frame: the footprint test, the step rules,
// the water line, the swim for the bank. None of them can see a body that has
// been refused in every direction for the last half minute, because none of
// them remembers anything.
//
// That gap is what the reports are: "a deer stuck on a shore", "a tiger I
// punched into the water is playing its run animation but cannot get out". A
// census over the shipping code found the same shape wherever it looked. Over
// 1,949 wild bodies at six sites, three simulated minutes each: 9.3% spent a
// stretch of at least 45 seconds inside a 2-unit circle, and 5.5% spent at
// least 8 seconds of it in a walk or a run cycle. Put deliberately in a hole,
// 61% never left a two-block pit, 67% never left a three-block one, and 76% of
// bodies knocked into water were still within two units of where they landed
// three minutes later.
//
// So this is one mechanism rather than a rule per terrain feature: measure
// progress, and when there has been none for long enough, go and find ground
// that is definitely walkable and head for it with the step rules loosened by
// one block. The alternative — a special case for pits, another for banks,
// another for wedges — is how this file got the shoreline bugs it already has
// three separate comments about.
/** How often a body's progress is measured, in seconds. */
const STALL_PERIOD = 1.0;
/**
 * How far it must get from where it was to count as having got anywhere.
 *
 * A distance from a fixed anchor and not ground covered per second, and the
 * difference is the whole of one of the census's findings. Measured per second,
 * a body circling inside a three-cell hollow covers a comfortable 1.1 cells
 * every second of it and reads as making progress for as long as anyone cares
 * to watch: 39% of bodies dropped into a one-block depression were still inside
 * a two-unit circle three minutes later, and not one of them ever tripped a
 * per-second test. Displacement from an anchor asks the question the player is
 * actually asking, which is whether the animal is still there.
 */
const STALL_RANGE = 2.0;
/**
 * Seconds of trying, without leaving that circle, before it is treated as stuck.
 *
 * Five, and it was measured at eight as well because eight is the more cautious
 * number and cautious looked right. It is not. Same seed, same six sites,
 * nothing else changed: a three-block pit went from 17% of bodies never leaving
 * it to 39%, water they had been knocked into from 29% to 57%, and open water
 * from 31% to 52%. Waiting longer to notice does not make the escape gentler,
 * it makes it miss — a body settles into whatever refuses it within a second or
 * two, and every extra second of patience is a second of an animal standing
 * still.
 */
const STALL_TRIES = 5;
/**
 * Seconds of escape licence once it is.
 *
 * Short on purpose. An escape holds the body in 'walk' while it runs, so a
 * licence longer than it takes to walk a dozen columns is a body visibly trying
 * for longer than it needed to; and a licence that has not worked in five
 * seconds is not going to. Running out is also what counts an attempt against
 * RELOCATE_AFTER, so a shorter one reaches the last resort sooner.
 */
const ESCAPE_TIME = 5;
/**
 * Layers a body may hop up while escaping, over the one it may hop ordinarily.
 *
 * Two and not three, and gated on the body being unable to translate *at all*
 * (see `mob.stuck` at the call site). Both halves are about paddocks: a fence
 * post stands 1.5 and is refused by _stepAhead's own shape test whatever this
 * says, but a player's two-block stone wall is not, and an animal that has
 * merely walked into a corner of its pen can still walk along the wall — so it
 * is never `stuck`, and never gets this. What gets it is a body in a hole.
 */
const ESCAPE_RISE = 2;
/** Columns the search for walkable ground reaches, and the nodes it may visit. */
const ESCAPE_LOOK = 12;
const ESCAPE_BUDGET = 260;
/**
 * Escapes that changed nothing before the body is simply moved.
 *
 * Three of them is 24 seconds of an animal visibly failing to leave a hole,
 * which is well past the point where the thing on screen is a bug rather than
 * an animal. It is still the last resort and it is still never done in view —
 * see the gate at the call site.
 */
/** Escape searches the whole planet may run in one frame. */
const ESCAPE_PER_FRAME = 2;
const RELOCATE_AFTER = 3;
/** ...and never nearer the player than this, in world units. */
const RELOCATE_MIN_DIST = 14;

const LOVE_SECONDS = 22;      // how long a fed animal stays willing
const BREED_RANGE = 4.5;      // how close a willing pair must be
/** How far a willing animal will walk to reach another. Comfortably past the
 *  spread you get from luring two of them to roughly the same field. */
const COURT_RANGE = 26;
const BREED_COOLDOWN = 90;    // rest between litters, so a herd can't runaway
const BABY_SECONDS = 210;     // calf → adult

/**
 * The footprint an animal is allowed, whatever it is drawn as.
 *
 * These used to be flat: halfW never past 0.47, halfL never past 0.80. Both
 * numbers were chosen for an animal around the player's size and they are right
 * for one — 0.47 is just under half a cell, which is what lets a fox or a deer
 * take a one-block gap or a doorway at all, and 0.80 is a cow's length. Neither
 * had anything to say about a giraffe, because when they were written nothing
 * was drawn past about 1.9 cells.
 *
 * The consequence is the "I can see inside animals when they are big" report.
 * `radius` is max(halfW, halfL), and _separate uses radius + PLAYER_RADIUS as
 * the distance it keeps the player from a body — so an elephant drawn a full
 * three cells across carried a 1.14-unit exclusion ring, well inside its own
 * silhouette. The player walks to the ring, the ring is inside the mesh, the
 * camera eye sits at 1.62 which is the middle of the barrel, and the Cube Pets
 * materials are double-sided so what you get is the inside of the far flank.
 *
 * So the clamp scales with the drawn height now, and does it in a way that
 * cannot disturb anything already tuned: the old numbers are the *floor*. A cow
 * (1.62), a deer, a polar bear (1.90) all resolve to exactly 0.47 / 0.80 as
 * before; only the elephant and the giraffe are past the point where the height
 * term wins, and they are the two the report is about. The hard ceiling stops a
 * fully grown predator from ever needing a corridor wider than three cells.
 *
 * The cost is real and worth stating. A footprint is nine samples spread over
 * halfW × halfL, so a wider one means _footprintCost refuses more moves: an
 * elephant now genuinely cannot fit down a two-block gap, and a giraffe in
 * dense forest will refuse a lot of headings. That is the correct answer to
 * "can this body go there" and it was previously answering wrongly, but it does
 * mean the giants lean harder on the strict-improvement rule in update() to
 * walk themselves out of tight ground. Spawn placement is unaffected — the
 * spawn searches only ever tested the centre column, so a giant could always
 * arrive somewhere it did not fit, and always relied on walking out. Pathing
 * costs nothing extra: _stepTo is per column and never reads the footprint.
 */
const FOOT_HALF_W_MIN = 0.47;
const FOOT_HALF_L_MIN = 0.80;
/*
 * These were throttling the big animals to a fraction of the body you can see.
 *
 * Measured against the drawn mesh: an elephant is 2.17 half-cells across and
 * was colliding as 0.86, so you could walk 1.31 cells into its flank before
 * anything stopped you — which is exactly "I can see their inside if I push
 * hard enough" — and its drawn body overlapped trunks the footprint test never
 * sampled, which is the walking-through-trees half of the same fault. A giraffe
 * was 1.02 against 1.76 drawn.
 *
 * `0.26 * height` was the binding constraint and it is simply too narrow for
 * anything tall: the real ratio is about 0.45 for a deer or a tiger and 0.71
 * for an elephant. At 0.55 and 0.70 the giraffe is no longer clamped at all,
 * and the elephant's overlap falls from 1.31 to about 0.49.
 *
 * The elephant is deliberately still clamped rather than let out to its full
 * 2.43. A footprint is a rectangle that has to fit between trees, and the
 * honest trade is stated in the paragraph above this one: a wider giant refuses
 * more headings in dense forest and leans harder on the strict-improvement rule
 * to walk itself out. Closing two thirds of the overlap is worth that; closing
 * all of it would pen the largest animals in the woods they spawn in.
 */
const FOOT_HALF_MAX = 1.90;
/** Drawn height a body is allowed to be, across and along, before the caps bind. */
const FOOT_W_PER_H = 0.55;
const FOOT_L_PER_H = 0.70;

const footCaps = (drawnHeight) => ({
  capW: Math.min(FOOT_HALF_MAX, Math.max(FOOT_HALF_W_MIN, drawnHeight * FOOT_W_PER_H)),
  capL: Math.min(FOOT_HALF_MAX, Math.max(FOOT_HALF_L_MIN, drawnHeight * FOOT_L_PER_H)),
});

/**
 * How much narrower the ground a body needs is than the body you can see.
 *
 * Two different questions were being answered with one number, and that is why
 * nothing could walk through a door.
 *
 *   - "how close may the player get before they are inside the mesh" — the
 *     silhouette, and the box measured off the model is exactly right for it.
 *     That is `radius`, and it is what the giants report was about.
 *   - "will this body fit through that gap" — the ground it needs, which is not
 *     the silhouette. `modelExtents` measures the whole drawn AABB in the rest
 *     pose, adds a margin for limb swing, and every one of those cells then has
 *     to be clear terrain. An animal is not a box: shoulders, ears, antlers, a
 *     tail and a swinging foreleg all sit inside that width and none of them is
 *     stopped by a door frame.
 *
 * Measured, the second reading of the box was refusing a one-block doorway to
 * 24 of the 41 species — including the husk, at 0.58 against the 0.50 a
 * one-cell gap allows. A husk that cannot come through a door is a night threat
 * that stops applying to anyone standing in a hut, and that is a change to what
 * torches and shelter are worth that nobody chose. The comment at
 * FOOT_HALF_W_MIN still claimed 0.47 "lets a fox or a deer take a doorway",
 * which had been false since that flat cap became a floor under a height-scaled
 * one: the cap it belongs to now reads 0.95 for a husk and never binds.
 *
 * The size of the allowance is not a guess — the player is the calibration. The
 * husk and the player wear the same character rig, that mesh measures 0.58 half
 * a width here, and the player's own hand-tuned collision half-width is
 * PLAYER_RADIUS, 0.34. So the game already walks that body through the world at
 * 0.59 of its drawn box, has done for as long as there has been a player, and
 * nobody has ever reported a shoulder in a wall. 0.56 is a shade tighter than
 * the allowance the player gets, and it is the number rather than 0.59 because
 * of where the two land: at 0.56 a cow and a polar bear take a doorway and at
 * 0.59 they are refused by half a hundredth, which is the kind of line that
 * reads as a bug from the far side of a fence.
 *
 * Across the body only. Length is left honest, because the two are not the same
 * claim: a snout in a wall is what the footprint test was written for (see
 * modelExtents on the woolly), an animal walks forwards into walls far more
 * often than sideways, and the doorway question is entirely about width.
 *
 * The cost, stated: a wide body may now bring its flank about 0.4 cells nearer
 * a wall face than its drawn edge — for most species nearer 0.25, which is the
 * same overlap the player has always had. That is the price of a door that the
 * things a door is for can actually use, and it is paid in the direction where
 * it is least often seen.
 *
 * Nothing about the giants moves. `radius` is taken from the drawn width, so
 * _separate keeps the exclusion ring the elephant and giraffe were given, and
 * both still need a three-cell gap to walk down after the tuck (1.02 and 1.06
 * against the 1.00 a two-cell gap allows) exactly as the note above intends.
 *
 * Not the fish. Every word above is about a body with limbs that fold and a
 * gait that swings them, and a fish has neither: its drawn box is its body,
 * held rigid, and the only rule it has is that rock and it cannot be in the
 * same place. Shrinking that would be shrinking the hull for no reason and
 * against the seabed clamp, which is measured in the same units.
 */
const FOOT_TUCK = 0.56;
const tuckW = (spec, drawn) => (spec.aquatic ? drawn : drawn * FOOT_TUCK);

/**
 * Horizontal half-extents of a built model, in cells, along its own axes.
 *
 * A single radius cannot describe these animals: a woolly is drawn 0.70 long
 * but only ~0.30 wide, so a circle either has to be too fat to fit through a
 * one-block gap or too small to keep the snout out of the wall — which is
 * exactly how a body ends up sunk into the block it stands against. Measuring
 * length and width separately lets the footprint be the shape the animal
 * actually is. Margins absorb the walk cycle, which swings limbs past the
 * rest pose.
 */
// No `scale` argument, and do not add one back. This took a second parameter it
// never read, which reads like a bug waiting to be "fixed" by multiplying the
// numbers below by it -- and that would double-apply the scale. `setFromObject`
// walks world matrices, and `model.root.scale.setScalar(scale)` has already run
// by the time the one caller gets here, so every number returned is in scaled
// cells. See also the notes at `_footprintCost` and `baseHeight`, which both say
// this box is world-space.
function modelExtents(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty() || !Number.isFinite(box.min.x)) return { halfW: 0.3, halfL: 0.3, tall: 1 };
  const drawn = Math.max(0, box.max.y - box.min.y);
  const { capW, capL } = footCaps(drawn);
  return {
    halfW: Math.min(capW, Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) + 0.03),
    halfL: Math.min(capL, Math.max(Math.abs(box.min.z), Math.abs(box.max.z)) + 0.03),
    // Cells of headroom needed, from the drawn height rather than a guess — a
    // browser's neck reaches well past what its body dimensions suggest, and
    // guessing left its head free to pass through leaves.
    tall: Math.max(1, Math.ceil(box.max.y - 0.001)),
    /**
     * How far the drawn body hangs *below* its own origin.
     *
     * Zero for every land animal, because those exports put the origin at the
     * feet — see `footOffset` in MobModels, which is this number by another
     * name. The fish pack does not: its models are centred on the body, so a
     * clownfish is drawn 0.17 cells below the height the physics thinks it is
     * at and a shark 0.55. Everything in this file treats `ck` as the bottom of
     * the body, so a fish held exactly on the seabed by the floor clamp was
     * drawn with a fifth of itself inside the sand — and the shark with half.
     * Recorded here so the swimmer's floor clamp can hold the *body* off the
     * bed rather than the origin.
     */
    belly: Math.max(0, -box.min.y),
  };
}

/** Advance a calf's growth clock. Scale is applied by _animate, which owns it. */
function mobGrow(mob, dt) {
  if (mob.baby <= 0) return;
  mob.baby = Math.max(0, mob.baby - dt);
}

/**
 * How big this animal is right now, 0.52 newborn to 1 grown.
 *
 * This must be folded into _animate rather than written to the model directly:
 * _animate reassigns root.scale every frame for the hurt flash, so anything
 * that sets scale outside it is silently overwritten on the next tick.
 */
function growthScale(mob) {
  if (mob.baby <= 0) return 1;
  const t = 1 - mob.baby / BABY_SECONDS;
  return 0.52 + 0.48 * t * t;
}
/**
 * Weighted draw for ordinary wildlife. Common animals appear more than once;
 * the cold-weather and aquatic species are picked by ground instead, so they
 * are absent here.
 */
/**
 * Who lives where.
 *
 * One flat table used to serve the whole planet, with a single exception for
 * penguins on ice — so a lion, a giraffe, a panda and a koala all turned up in
 * the same temperate meadow. On a world you can walk around in four minutes
 * that does not read as variety, it reads as a zoo with the fences taken out,
 * and it flattens biomes that the terrain generator went to some trouble to
 * make distinct.
 *
 * Weighted by repetition, which keeps the table legible: three cows to one dog
 * is three entries to one. Anything not listed falls back to COMMON, so a new
 * biome cannot spawn an empty world.
 */
/** Biome id → name, so the table above can be keyed by something readable. */
const BIOME_NAME = [];
for (const [name, id] of Object.entries(BIOME)) BIOME_NAME[id] = name;

/**
 * What counts as forage for a bee. Blooms and the things that grow beside them;
 * leaves are checked separately through IS_LEAF, so a tree counts without every
 * species of leaf having to be listed here.
 */
const BLOOM = new Set(
  ['flower_red', 'flower_blue', 'flower_gold', 'tall_grass', 'sapling']
    .map((n) => ID[n]).filter(Boolean),
);

/**
 * Where each monster belongs, and nowhere else.
 *
 * Deliberately not folded into `SPAWN_BY_BIOME`: that table is drawn from
 * constantly to keep the wildlife budget full, and anything in it is common by
 * construction. These are drawn from their own tick, at their own rate, against
 * their own cap — which is what makes "rare" a property of the code rather than
 * a hope about a weight.
 *
 * A biome with no entry has no monsters at all, and that is the point: the
 * meadow you build your hut in stays yours.
 */
const MONSTER_BY_BIOME = {
  SNOW: ['yeti', 'yeti', 'ghost'],
  TUNDRA: ['yeti', 'skull'],
  MOUNTAIN: ['cyclops', 'bat', 'dragon'],
  DESERT: ['cactus_monster', 'cactus_monster', 'skull'],
  BADLANDS: ['demon', 'greendemon', 'demon', 'skull', 'dragon'],
  SAVANNA: ['greendemon', 'skull'],
  FOREST: ['mushroom_monster', 'mushroom_monster', 'ghost'],
  PINE_FOREST: ['mushroom_monster', 'ghost', 'bat'],
  OCEAN: ['cthulhu'],
  BEACH: ['cthulhu', 'ghost'],
  PLAINS: ['alien', 'alien_tall'],
  // MEADOW is missing on purpose — see above.
};

const COMMON = ['bunny', 'bunny', 'bee', 'caterpillar', 'fox'];
const SPAWN_BY_BIOME = {
  SNOW: ['penguin', 'penguin', 'polar', 'fox', 'deer'],
  TUNDRA: ['deer', 'deer', 'fox', 'fox', 'bunny', 'polar'],
  MOUNTAIN: ['deer', 'fox', 'bunny', 'bee', 'tiger'],
  // Sparse on purpose: an empty-feeling desert is the point of a desert. The
  // crab that used to be listed here has gone: it was here because sand is sand
  // and the biome tables were written off the block underfoot, which put crabs
  // twenty columns inland in a dune field. A crab belongs in the surf, and the
  // shoreline test in the spawn tick now enforces that wherever it is listed.
  DESERT: ['lion', 'caterpillar', 'bee'],
  BADLANDS: ['lion', 'tiger', 'caterpillar'],
  SAVANNA: ['giraffe', 'giraffe', 'elephant', 'lion', 'tiger', 'deer', 'parrot'],
  // Parrots are listed in more than one place now, and that is not decoration.
  // The parrot used to hop, so it came off the *land* budget and its single
  // entry here was enough to see one occasionally. Giving it wings moved it onto
  // the flier budget, where it draws against the bee — and the bee is in eight
  // of these lists to the parrot's one, and is smaller, so the size weighting
  // favours it too. Measured after the change and before this line: eighteen
  // bees and zero parrots. Wings made the bird rarer, which is the opposite of
  // the point.
  FOREST: ['deer', 'deer', 'fox', 'bunny', 'bunny', 'panda', 'koala', 'monkey',
    'parrot', 'parrot', 'bee', 'caterpillar'],
  PINE_FOREST: ['deer', 'deer', 'fox', 'fox', 'bunny', 'beaver', 'bee'],
  MEADOW: ['cow', 'cow', 'cow', 'bunny', 'bunny', 'chick', 'chick', 'dog', 'cat',
    'bee', 'bee', 'deer'],
  PLAINS: ['cow', 'cow', 'bunny', 'bunny', 'chick', 'chick', 'chick', 'dog',
    'cat', 'deer', 'fox', 'bee'],
  OCEAN: ['crab', 'crab', 'beaver'],
  BEACH: ['crab', 'crab', 'crab', 'bunny', 'bee', 'parrot'],
};

// --- the merchant's own spawn path -------------------------------------------
// Kept out of the biome tables on purpose. Everything else is population: top the
// world up towards a headcount and pick a species by weight. A merchant is an
// event — at most one alive, a long wait between them, and a life span, so the
// one you met is gone by the time you come back for it and the next turns up
// wherever you happen to be standing.
const MERCHANT_FIRST = 120;      // seconds of grace after a world starts
// Seconds between one leaving and the next.
//
// Raised from 300 because the spawn roll is only half of how often a merchant
// is *present*. He lives for MERCHANT_LIFE, so with a 300s gap and a ~33s roll
// the planet had a trader standing on it about 56% of the time — better than
// even odds at any given moment, which is a resident, not an event. At 900 it
// is nearer a fifth, and since he now only arrives in daylight, a night is
// always his absence. You are alone here; that has to be the default state and
// meeting someone has to be the exception.
const MERCHANT_COOLDOWN = 900;
// Per spawn tick once the wait is over. The comment used to say "(6s)" and the
// number was chosen against that, but SPAWN_PERIOD was shortened to 2.0 when
// the wildlife top-up rate was fixed and this was never rescaled — so a
// merchant arrived roughly three times as often as intended, about 11 seconds
// after the cooldown instead of 33. A thing that turns up that reliably is not
// an event. 0.06 against a 2s tick is the 0.18-per-6s this always meant.
const MERCHANT_CHANCE = 0.06;
const MERCHANT_LIFE = 420;       // seconds before it moves on for good
/** Coins one trader can pay out before it has nothing left to buy with. */
const MERCHANT_PURSE_MIN = 140;
const MERCHANT_PURSE_MAX = 460;

/** Every model the species table can ask for, for the one-time preload. */
export const MOB_MODEL_URLS = Object.values(SPECIES).flatMap((s) => s.urls);

// --- the manager ------------------------------------------------------------

export class Mobs {
  constructor(scene, planet, drops) {
    this.planet = planet;
    this.drops = drops;
    this.group = new THREE.Group();
    this.group.name = 'mobs';
    scene.add(this.group);
    this.list = [];
    this.spawnTimer = 4;
    /**
     * World position of the spawn point, or null if this world was loaded
     * rather than created. Set by populate(); read by _nearHome.
     */
    this.homePos = null;
    /** Seconds before a merchant may appear. Reset every time one leaves. */
    this.merchantT = MERCHANT_FIRST;
    /** (mob) => void — a merchant has just arrived, for a nudge to the player. */
    this.onMerchant = null;
    /**
     * (kind, mob) => boolean — 'idle' | 'hurt' | 'death'. Wired to Audio.mob(),
     * whose `false` means "no sound was made"; _tryVocalise reads it so silence
     * does not spend the herd's call budget.
     */
    this.onSound = null;
    /** (damage, mob) => void — a hostile landed a blow on the player. */
    this.onAttack = null;
    /** (mob) => void — a hostile is alight, for smoke and embers. */
    this.onBurn = null;
    /**
     * (worldPos, out) => out — coloured block light reaching a point, already
     * scaled into the units a material's `emissive` wants. Supplied by main;
     * null means no torchlight on mobs, which is how they rendered before this
     * existed and is a safe thing for a test harness to leave unset.
     */
    this.blockLightAt = null;
    /** Swings in flight, so the hit lands on contact rather than on the decision. */
    this._pendingHits = [];
    /** Animals taken by a predator this frame, removed once the tick is over. */
    this._kills = [];
    /**
     * Everything alive that could frighten anything, rebuilt once per
     * THREAT_PERIOD by one pass over this.list. Prey reads this short list
     * instead of scanning the whole roster — see the note above THREAT_PERIOD
     * for why that inversion is the whole cost story.
     */
    this._threats = [];
    this._threatT = 0;
    /** Recent bolts, as {pos, threat, mob, t}, for the herd cue. Expire on ALARM_LIFE. */
    this._alarms = [];
    /**
     * Stalkers that stopped being looked at this frame, on exactly the same
     * terms and for the same reason: update() walks `this.list` in reverse and
     * a helper that splices out of it moves the cursor's own entry. Collected
     * here, drained after the loop. Silent — `_die` would spill drops, play the
     * death clip and fire onSound, and none of those is what "he is simply not
     * there when you look back" means.
     */
    this._vanished = [];
    /**
     * The camera, for the one mob whose whole behaviour is a question about
     * what the player can see. Supplied by main, exactly as blockLightAt is,
     * and null in a headless harness — which reads as "nobody is looking",
     * so a stalker that somehow existed there would be collected on its first
     * frame rather than wandering the planet unobserved forever.
     */
    this.camera = null;
    /**
     * Which `character-*.glb` the player is wearing, so the stalker can wear
     * it too. Null falls back to the species' own url.
     */
    this.playerModel = null;
    /**
     * The world is a hostile one: the carnivores hunt the player, and the dark
     * brings more of the things that already did.
     *
     * A flag rather than a difficulty name, and that is deliberate. This file
     * has no business knowing what the New Game screen offers — `game/NewGame.js`
     * owns which worlds are which, and main.js sets this from `huntsOnSight`.
     * What lives here is the only part that is a fact about animals: *which*
     * species change, and by how much the night fills. See the `acquires` test
     * in _hunt and MAX_HOSTILE_SAVAGE.
     */
    this.savage = false;
    /**
     * The player is not really there: a spectator of their own world.
     *
     * Nothing may target them, nothing may push them, and nothing may swing at
     * them. It is one flag on the manager rather than a check per behaviour
     * because there is exactly one player, and because "can anything reach the
     * player" is a property of the world in this state rather than of any
     * animal in it. Damage is refused a second time at main.js's own door — see
     * `_takeHit` — so a path missed here still cannot cost a spectator health.
     */
    this.ghost = false;
    /** Seconds before the planet may roll for another sighting. */
    this.stalkerRest = 0;
    /** sun elevation at the player, refreshed each update */
    this.daylight = 1;
    // --- the night stalk's clocks, and why they are here and not on the cat ---
    // One roll for the whole planet per PROWL_PERIOD, taken by the first
    // eligible big cat the tick reaches, then PROWL_REST during which nothing
    // may start another. They are ticked once per frame in update() rather than
    // inside _prowl, because _prowl runs once per cat and a clock decremented
    // there would run N times faster with N cats on the meadow — which is
    // precisely the bug the per-animal version had. See PROWL_CHANCE.
    this.prowlT = PROWL_PERIOD;
    this.prowlRest = 0;
    this.voxCooldown = 0;
    /** The merchant's bell runs on its own clock, clear of the herd limiter. */
    this.bellT = 0;
    /**
     * Escape searches left this frame — see the guard in _unstick. Refilled at
     * the top of update() rather than being a rate on the mob, because the cost
     * this bounds is a frame's cost and not an animal's.
     */
    this._escapeBudget = 0;
    /** Route searches left this frame — see PATH_PER_FRAME. */
    this._pathBudget = 0;
    this.voxCount = 0;          // diagnostics: calls actually emitted
    this.voxSuppressed = 0;     // diagnostics: calls dropped by the rate limit
    this._nextId = 1;
  }

  clear() {
    for (const m of this.list) this._release(m);
    this.list.length = 0;
    this.merchantT = MERCHANT_FIRST;
    // Both deferred-removal queues hold bodies that are already gone. Leaving
    // them would be harmless — the drain looks each one up by indexOf and finds
    // nothing — but a queue that survives the world it refers to is the shape
    // of a bug, not a bug that has happened yet.
    this._kills.length = 0;
    this._vanished.length = 0;
    // Same reasoning: both of these name bodies from the world just thrown
    // away, and _threats in particular would hand the next world's prey a
    // predator that no longer exists.
    this._threats.length = 0;
    this._threatT = 0;
    this._alarms.length = 0;
    this.stalkerRest = 0;
  }

  /** The live merchant, or null. There is never more than one. */
  merchant() {
    for (const m of this.list) if (m.spec.trader) return m;
    return null;
  }

  /** Drop a merchant and start the wait for the next one. */
  _retireMerchant(mob, index) {
    this.merchantT = MERCHANT_COOLDOWN;
    this._release(mob);
    this.list.splice(index, 1);
  }

  _release(mob) {
    // Anything holding a reference to this body — a carnivore mid-chase — has
    // to be able to tell that it is gone. It is off the list by the time the
    // predator next looks, but its `pos` stops updating, so without this flag a
    // tiger spends a second and a half walking at a ghost.
    mob.released = true;
    this.group.remove(mob.model.root);
    mob.model.mixer.stopAllAction();
    mob.model.mixer.uncacheRoot(mob.model.root);
    // Geometry and the texture are shared with the rest of the species — a
    // clone only borrows them, so disposing either would blank the whole herd.
    // The material clones made for the damage tint are this mob's own.
    for (const m of mob.model.owned) m.dispose();
    // So is its skeleton, and with it the bone texture three hangs off the
    // skeleton on first render. This was the game's only unbounded GPU leak:
    // the skinned species (fish, deep_fish) left ~5 undisposed GL textures per
    // body, so a travelling player climbed ~126 textures a minute forever. See
    // `MobModels.releaseSkeletons` for the measurement.
    MobModels.releaseSkeletons(mob.model.root);
  }

  // --- spawning -------------------------------------------------------------

  /** Column index for possibly out-of-range continuous cell coords, cross-face safe. */
  _colOf(f, ci, cj) {
    _probe.f = f; _probe.ci = ci; _probe.cj = cj; _probe.ck = 0;
    if (ci < 0 || ci >= F || cj < 0 || cj >= F) normalizeCell(_probe);
    const i = Math.min(F - 1, Math.max(0, Math.floor(_probe.ci)));
    const j = Math.min(F - 1, Math.max(0, Math.floor(_probe.cj)));
    return cidx(_probe.f, i, j);
  }

  /**
   * Walk `steps` columns away from `nearCol` and return where you end up.
   *
   * Direction is held and only occasionally turned, which matters more than it
   * sounds. Redrawing the direction every step is a *diffusive* walk: its
   * displacement grows with the square root of the step count, so 40 steps only
   * gets about six columns from where it started. Every spawn search in this
   * file used to do that, and every one of them also required the result to be
   * at least SPAWN_MIN_DIST (20 units) from the player — a bar the walk almost
   * never cleared. Measured over 300 walks: median displacement 4.8 units, and
   * not one reached 20. Wildlife top-up, both husk paths and the fish were all
   * silently dead; only populate() worked, and only because it skips the
   * distance test entirely.
   *
   * Holding a heading covers ground linearly. Same measurement, median 28.
   */
  _walkOut(nearCol, steps) {
    let col = nearCol;
    let dir = (Math.random() * 4) | 0;
    for (let s = 0; s < steps; s++) {
      // Veer square, never reverse: colNeighbor's 0/1 are the two ways along i
      // and 2/3 the two along j, so turning means swapping which pair the
      // direction is drawn from. Adding one would just walk back.
      if (Math.random() < 0.06) {
        dir = dir < 2 ? 2 + ((Math.random() * 2) | 0) : ((Math.random() * 2) | 0);
      }
      col = colNeighbor(col, dir);
    }
    return col;
  }

  /**
   * Go `units` of world distance from `nearCol` on a random bearing.
   *
   * The difference from _walkOut is that this one ARRIVES. _walkOut holds a
   * heading but veers, so the distance it covers for a given step count is a
   * broad distribution that mostly falls short — which is fine for "somewhere
   * over there" and useless for "fill this band". Here the bearing is drawn
   * once and the whole offset is handed to stepColumn, which walks the seams
   * itself; nothing in this function does arithmetic on a column index.
   *
   * Aimed, measured, then corrected once, rather than converted with
   * CELL_SIZE and hoped for. CELL_SIZE is the planet's AVERAGE cell width, and
   * a cubesphere is a gnomonic projection, so a real cell is that wide in only
   * one place. Measured on the real planet, 200 draws per site, horizontal
   * displacement (both ends read at the same layer — reading each at its own
   * surface height instead measures the hill and not the walk, which is how
   * the first version of this table came out backwards):
   *
   *   realised / asked        D=40   60    80   100   120
   *   one pass, at a face centre    1.000 0.995 0.990 0.986 0.981
   *   one pass, at the world spawn  0.948 0.942 0.943 0.935 0.906
   *   one pass, near a face edge    0.772 0.780 0.815 0.809 0.852
   *   corrected, worst of the three 1.002 1.005 1.006 1.008 1.012
   *
   * So a ring asked for at 120 units was a ring of 93 for a player standing
   * near a face edge and 118 for one at a face centre: the size of the world's
   * inhabited disc depended on where on the planet you happened to be. The
   * second pass costs one more stepColumn walk — a few hundred array lookups,
   * a handful of times per two-second spawn tick — and removes the whole of it
   * without needing a model of the projection.
   */
  _walkTo(nearCol, units) {
    const th = Math.random() * Math.PI * 2;
    const ca = Math.cos(th), sa = Math.sin(th);
    const a = colParts(nearCol);
    // Both ends read at the same layer, so this is horizontal displacement and
    // not a hill. The layer itself is arbitrary; only the difference is used.
    cellToWorld(a.f, a.i + 0.5, a.j + 0.5, R_SEA - R_MIN, _wa);
    let n = units / CELL_SIZE;
    let col = stepColumn(nearCol, Math.round(ca * n), Math.round(sa * n));
    const b = colParts(col);
    cellToWorld(b.f, b.i + 0.5, b.j + 0.5, R_SEA - R_MIN, _wb);
    const got = Math.hypot(_wb[0] - _wa[0], _wb[1] - _wa[1], _wb[2] - _wa[2]);
    if (got > 1) {
      n *= units / got;
      col = stepColumn(nearCol, Math.round(ca * n), Math.round(sa * n));
    }
    return col;
  }

  /** Grass column with headroom, or null. */
  _findSpawnColumn(nearCol, playerPos) {
    const p = this.planet;
    for (let tries = 0; tries < 40; tries++) {
      // Without a player to keep clear of, this is world start.
      //
      // Both bands cover the whole disc the placement test below allows, and
      // both are drawn EVENLY OVER IT rather than evenly over the distance —
      // see spawnDist for the 32.7x density gradient that not doing so
      // produced, which is the whole of the "they are mostly near the spawn
      // area" report. The world-start band gets the same treatment because
      // the founding herd is the one population a player keeps for the rest
      // of the session: 24% of it used to land inside twenty units of where
      // they woke up, and that clearing is where they then build.
      const col = this._walkTo(nearCol, playerPos
        ? spawnDist(SPAWN_MIN_DIST, SPAWN_FAR)
        : spawnDist(SEED_NEAR, SPAWN_FAR));
      const k = p.surfaceK(col);
      if (k < 0 || k > D - 6) continue;
      const surf = p.at(col, k);
      if (surf !== ID.grass && surf !== ID.sand && surf !== ID.snow) continue;
      if (p.solidAt(col, k + 1) || p.solidAt(col, k + 2)) continue;
      // a sandy seabed passes every test above, so reject anything submerged
      if (p.liquidAt(col, k + 1) || p.liquidAt(col, k + 2)) continue;
      // A hearth keeps the surface around it clear too, not just the caves.
      if (this._warded(col, k)) continue;
      if (playerPos) {
        // don't materialise inside the player's view, and don't drop one just
        // outside the despawn ring where it would be culled again next second
        const { f, i, j } = colParts(col);
        cellToWorld(f, i + 0.5, j + 0.5, k + 1, _p);
        const d = Math.hypot(_p[0] - playerPos.x, _p[1] - playerPos.y, _p[2] - playerPos.z);
        if (d < SPAWN_MIN_DIST || d > DESPAWN_RADIUS - 25) continue;
      }
      return { col, k };
    }
    return null;
  }

  spawn(type, col, k, seed) {
    const spec = SPECIES[type];
    if (!spec || this.list.length >= MAX_MOBS) return null;
    const { f, i, j } = colParts(col);

    const s = (seed === undefined || seed === null) ? ((Math.random() * 0x7fffffff) | 0) : (seed | 0);
    const rng = makeRng(s || 1);
    const variant = Math.floor(rng() * spec.urls.length) % spec.urls.length;
    // Stable per individual, and per species: ±12% by default, wider on the
    // herd animals where it reads and narrow on the ankle-high ones where it
    // cannot. Still exactly one draw from the stream, so old seeds keep the
    // model variant they were saved with.
    const spread = spec.sizeVar ?? SIZE_VAR;
    const sizeJitter = 1 + (rng() * 2 - 1) * spread;

    // The stalker wears the player's own body. `playerModel` is a url main has
    // already had `MobModels.prepare` fetch — it is the model standing on the
    // screen — so `isReady` is a formality, and falling back to the species url
    // rather than refusing means a picker mid-change can never eat a sighting.
    const url = (spec.phantom && this.playerModel && MobModels.isReady(this.playerModel))
      ? this.playerModel
      : spec.urls[variant];
    const model = MobModels.instantiate(url);
    // The model may not have loaded — a failed fetch, or a spawn racing world
    // start. Refusing here is right: an invisible mob that still collides and
    // bites is worse than one that never appears.
    //
    // Said out loud, once per url. Refusing quietly is correct behaviour and a
    // terrible diagnostic: a species whose file is misnamed simply stops
    // existing, and nothing anywhere says so. The rule this enforces is that
    // nothing can hurt the player without being drawable, and the rule is worth
    // being able to see hold.
    if (!model) {
      if (!this._missing) this._missing = new Set();
      if (!this._missing.has(url)) {
        this._missing.add(url);
        console.warn(`[Mobs] no model for "${type}" (${url}) — it will never spawn`);
      }
      return null;
    }

    // Sizes are authored as a target height in cells, and each rig has its own
    // idea of a unit, so the scale is derived from the measured rest pose.
    const scale = (spec.height / MobModels.modelHeight(url)) * sizeJitter;
    model.root.scale.setScalar(scale);

    // Materials stay exactly as the loader made them, shared across the whole
    // species. Pain is shown by the scale pop in _animate instead of by tinting
    // emissive: that needed a per-mob material clone, and every variation on
    // touching these materials ended with the animal rendering flat white.
    //
    // The flash is back, but through `color` rather than anything on the map.
    // The white bug was the *texture* being written to — assigning colorSpace,
    // filters or needsUpdate forces a re-upload from an ImageBitmap that has
    // already been consumed. A cloned material with its own `color` shares the
    // same map object untouched, so it is safe.
    model.owned = [];
    model.root.traverse((n) => {
      if (!n.isMesh || !n.material) return;
      const cloned = Array.isArray(n.material)
        ? n.material.map((m) => m.clone())
        : n.material.clone();
      n.material = cloned;
      for (const m of (Array.isArray(cloned) ? cloned : [cloned])) {
        model.owned.push(m);
        // Block light, wired here and driven in _animate.
        //
        // `emissive` alone is one flat colour over the whole body, which on a
        // textured animal reads as a coat of paint. `emissive * emissiveMap`
        // is `texel * light` — arithmetically the same shape as the term the
        // terrain adds for its own baked block light, so a torch-lit cow and
        // the torch-lit dirt under it are shaded by the same expression, and
        // it needs no shader patch on a glTF material we do not own.
        //
        // Reusing `map` as the emissive map is the same rule as the damage
        // tint and `MobModels.lit`: the texture object is passed across
        // untouched. Nothing here writes to it — assigning it to a second
        // slot binds the WebGLTexture that is already uploaded — and it is
        // writing to it that renders the mob flat white.
        // Not for a phantom. `emissiveMap` is how a torch reaches an ordinary
        // body, and a stalker that brightens when he walks past a lamp is a
        // stalker who has stopped being a silhouette. He takes no block light
        // at all — see the guard in _animate — so this slot stays empty, which
        // also means the one `needsUpdate` in this file never fires for him.
        if (m.map && m.emissive && !spec.shade) { m.emissiveMap = m.map; m.needsUpdate = true; }
        // Darken, before the base colour is captured, so every later read of it
        // — the damage tint, the block light — is already working against the
        // dimmed figure rather than fighting it back to full brightness.
        //
        // A multiply into `color` on a material clone this mob owns. Nothing is
        // written to `map`, nothing is re-uploaded, and no flag is set: this is
        // the same safe operation the damage tint performs sixty times a second
        // on every animal on the planet. See `lit()` for the version of this
        // that renders the model flat white.
        if (m.color && spec.shade) m.color.multiplyScalar(spec.shade);
        // A self-lit mob. `emissiveMap` is already the albedo for anything that
        // has one (see above), so this only has to set how much of it survives
        // the dark; without a map the flat emissive colour carries it.
        if (m.emissive && spec.glow) {
          m.emissive.setRGB(spec.glow, spec.glow, spec.glow);
          if (m.map) { m.emissiveMap = m.map; m.needsUpdate = true; }
        }
        // The colour this material was authored with, kept so the damage tint
        // can multiply into it rather than replace it. Untextured models — the
        // fish — carry their whole appearance here.
        if (m.color) m.userData.baseColor = m.color.clone();
      }
      // (No layer juggling here. Putting a mesh on layer 1 to "reach" the
      // entity fill was tried and does nothing: three tests a light's layers
      // against the camera, not against each object, so object layers cannot
      // select lights at all. The fill is a plain scene light now — see Sky.)
    });
    // Two lights where the face is. Parented to the rig's `head` node rather
    // than to the root, so they ride every nod and tilt the clips key — an eye
    // that stays level while the head turns is a decal, and reads as one.
    // Guarded on the node actually being there: this is the Blocky Characters
    // rig and it always is, but a species flagged `eyes` on some future model
    // that is not should lose its glow, not throw inside the spawn loop.
    if (spec.eyes) {
      const head = model.root.getObjectByName('head');
      if (head) {
        for (const sx of [-1, 1]) {
          const q = new THREE.Mesh(EYE_GEOM, EYE_MAT);
          q.position.set(EYE_X * sx, EYE_Y, EYE_Z);
          // No shadow either way: a quad that casts one puts two black bars on
          // the ground in front of him, and one that receives is not a light.
          q.castShadow = false;
          q.receiveShadow = false;
          // The head is 0.8 cells across at the far end of a 90-unit sighting,
          // and the eyes are a tenth of that. Three's per-object frustum test
          // is not the thing that should be deciding whether they are drawn.
          q.frustumCulled = false;
          head.add(q);
        }
      }
    }
    this.group.add(model.root);

    const ext = modelExtents(model.root);
    const mob = {
      id: this._nextId++, type, spec, model, seed: s, variant,
      scale, sizeJitter,
      cell: { f, ci: i + 0.5, cj: j + 0.5, ck: k + 1.02 },
      vel: { i: 0, j: 0, k: 0 },
      pos: new THREE.Vector3(),
      prevPos: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      heading: rng() * TAU,
      want: 0,
      state: 'idle',
      stateT: spec.idleMin + rng() * (spec.idleMax - spec.idleMin),
      health: spec.health,
      grounded: false,
      stride: rng() * TAU,      // walk-cycle phase, advanced by distance
      idleT: rng() * 100,       // personal clock for bob / sway
      voxT: 2 + rng() * (VOX_MAX - 1),   // personal, jittered call clock
      blinkT: 1 + rng() * 4,
      blink: 0,
      graze: 0,
      speedNow: 0,
      /**
       * ...and how fast it is actually travelling, smoothed.
       *
       * `speedNow` is intent and the clip was chosen from it alone, so a body
       * whose every move was being refused played a full run cycle on the spot
       * — which is the half of the shoreline report the player could actually
       * see. This is measured from the ground covered, and the gait takes the
       * lesser of the two: it can only ever quieten an animation, never raise
       * one, so nothing that reads correctly today changes.
       */
      gait: 0,
      hurtT: 0,
      knockA: 0, knockB: 0, knockT: 0,   // decaying shove from the last blow
      // Being thrown rather than walking: the walking rules are suspended
      // until it is back on its feet. See the tumble in update().
      tumbling: false,
      // Could not move at all last frame, so the terrain check on its turn is
      // suspended — see the steering in update().
      stuck: false,
      // --- the progress watchdog, and the escape it starts: see _unstick ---
      // (Named `prog*` rather than `stall*`: _hunt already owns `stallT`, which
      // counts a chase that is not closing, and one field cannot mean two
      // things.)
      /** Seconds since progress was last measured. */
      progT: 0,
      /** Where the body was when it was, in world space. */
      progAt: new THREE.Vector3(),
      /** Consecutive measurements that found it trying and getting nowhere. */
      progN: 0,
      /** Seconds of escape licence left; 0 means it is not escaping. */
      escapeT: 0,
      /** The column it is escaping to, or -1. */
      escapeCol: -1,
      /** Escapes that ran out without the body getting anywhere. */
      escapeFails: 0,
      /** Highest layer reached since leaving the ground, or null if it has not. */
      fallFrom: null,
      lavaT: 0,            // seconds until the next instalment of the lava toll
      alight: 0,           // ...and seconds still burning after climbing out
      alightT: 0,          // when the next instalment of *that* falls due
      contactT: 0,         // ...and the same for anything spiky it is leaning on
      swimming: false,     // in water, and at home in it
      wading: false,       // in water, and very much not
      /**
       * ...and the third one, which is neither: a land animal with water round
       * its legs, at any depth it can still stand in.
       *
       * `wading` deliberately means "out of its depth" and so is false in the
       * shallows, which is right for the swim override — an animal in an inch
       * of water is walking, not drowning. But it left every *settled*
       * behaviour with no test of the medium at all, and "I saw some land
       * animals still going to water doing eating animations" is that hole:
       * a cow standing in a fordable stream is not wading, so nothing stopped
       * it grazing, and grazing is what puts the eat clip on the screen.
       */
      legsWet: false,
      swimT: 0,            // when to look for the bank again
      swimWant: null,      // and the bearing it found last time it looked
      /** Consecutive looks that found no bank it could climb — see SWIM_GIVE_UP. */
      swimFail: 0,
      /** ...and once it has given up, the bearing along the shore it follows. */
      swimAlong: null,
      bestDist: Infinity,  // closest it has got while hunting, for the stall test
      stallT: 0,
      slideT: 0, slideDir: 1,   // which way it is currently going round a wall
      huntCooldown: 0,
      fromCave: false,     // which spawn budget it belongs to
      swingT: 0,           // hostiles: cooldown left before the next blow
      lungeT: 0,           // seconds left of the pounce pop — see _lunge
      burnT: 0,            // hostiles: seconds alight in daylight
      hauntT: 0,           // phantoms: seconds left before an unbroken stare ends
      // --- predation ---
      // `hungerT` is "when may I hunt again", not "how close am I to starving".
      // Nothing here ever costs a mob health, and that is deliberate on the same
      // grounds the swim override gives for there being no drowning clock: an
      // animal that starved would do it out past the despawn ring where nobody
      // can see it, and the only visible effect would be a wildlife budget that
      // quietly empties. The player's own `energy` bar is the other half of a
      // food economy the player is in and the herd is not.
      //
      // The hunger clock is seeded from Math.random rather than from `rng` on
      // purpose: `rng` is the per-individual stream that decides the model
      // variant and the size, and drawing from it here would move every saved
      // animal's appearance. Staggered so a pride that spawned together does
      // not all set off at the same instant.
      hungerT: Math.random() * PREY_REST_MIN,
      preyT: Math.random() * PREY_PERIOD,
      /** Seconds until this hunter may bite again. See BITE_PERIOD. */
      biteT: 0,
      /** Last sight check's answer, and the clock to the next. See SIGHT_PERIOD. */
      sighted: false,
      sightT: 0,
      prey: null,
      // --- and the prey's own side of it: see _spook ---
      /** Accumulated unease, 0..SPOOK_TRIGGER-and-a-bit. */
      spook: 0,
      /** Seconds until this animal next looks around. Staggered, like hungerT. */
      spookT: Math.random() * SPOOK_PERIOD,
      /** Seconds it will not start a new bolt for — the wary pause after one. */
      spookRest: 0,
      /** Seconds left of the current bolt, 0 when it is not running from anything. */
      bolt: 0,
      /** What it is running from, when it can see it. */
      boltFrom: null,
      /** ...and where it was, for a bolt started off a neighbour's alarm. */
      boltAt: new THREE.Vector3(),
      // --- up a tree, monkeys only ---
      /** Layer it is climbing toward, or null when it is not climbing. */
      climbTo: null,
      /** Seconds left sitting in the canopy before it heads back down. */
      perchT: 0,
      /** Staggered, so a troop that spawns together does not all go up at once. */
      climbRestT: Math.random() * CLIMB_REST,
      climbT: Math.random() * CLIMB_PERIOD,
      /** Stall detector for a climb that is not making progress. */
      climbLastK: 0,
      climbStallT: 0,
      /** The column a climb is anchored to, so it cannot drift out of it. */
      climbCi: 0,
      climbCj: 0,
      /** Fall immunity left over from a climb that ended in the air. */
      climbGrace: 0,
      // --- the night stalk, big cats only ---
      prowl: 0,            // seconds of telegraph left; 0 means it is not
      // There is deliberately no per-animal prowl clock here any more. It was
      // `prowlT: Math.random() * PROWL_PERIOD`, staggered like the hunger clock
      // — and staggering *when* each cat rolled did nothing about how often the
      // player was rolled at, which was the whole trouble. The clock is on the
      // planet now; see PROWL_CHANCE.
      growlT: 0,
      creep: false,        // moving at stalking pace rather than walking pace
      stalked: false,      // it came for you off a night stalk, not a grudge
      preyChase: 0,
      kills: 0,
      grown: 1,            // permanent size gained from kills, 1..GROW_MAX
      taken: false,        // eaten this frame, awaiting collection
      released: false,     // detached from the world; never chase one of these
      dying: 0,            // seconds left of the death animation
      target: null,        // 'player' once a hostile has noticed you
      // Collision footprint in cells, measured from the built model rather than
      // guessed from the spec, and kept as a length and a width rather than one
      // radius — see modelExtents.
      ...ext,
      // Two widths, and which one a piece of code wants is the whole of
      // FOOT_TUCK: `drawW` is the body you can see and `halfW` is the ground it
      // needs. Everything that samples the terrain reads `halfW`; `radius`, and
      // through it every body-against-body distance in the file, reads `drawW`.
      drawW: ext.halfW,
      halfW: tuckW(spec, ext.halfW),
      // The same numbers again, kept so a predator that eats its way larger can
      // scale its body without re-measuring. Re-measuring is not an option once
      // the animal is in the world: modelExtents reads a *world-space* box, and
      // it is only ever the truth while the root still sits unrotated at the
      // origin, which is exactly here and nowhere else.
      baseHalfW: ext.halfW,
      baseHalfL: ext.halfL,
      baseBelly: ext.belly,
      baseHeight: spec.height * sizeJitter,
      get radius() { return Math.max(this.drawW, this.halfL); },
      love: 0,             // seconds left willing to breed
      breedCooldown: 0,    // rest before breeding again
      baby: 0,             // seconds left as a calf; 0 means fully grown
      placed: false,
      frame: { ea: [0, 0, 0], eb: [0, 0, 0], up: [0, 0, 0], arcA: 1, arcB: 1 },
    };
    mob.want = mob.heading;
    if (spec.trader) {
      // Stock is rolled per individual, never per species, so two merchants a
      // world apart are carrying different things.
      mob.stock = rollStock(rng);
      mob.life = MERCHANT_LIFE;
      // A float, not a treasury. Without a cap the merchant is an infinite coin
      // faucet and any renewable block becomes a money printer — cobblestone
      // regrows as fast as you can swing at it. Rolled per individual, so which
      // trader you meet decides how much you can offload.
      mob.purse = { coins: MERCHANT_PURSE_MIN
        + Math.floor(rng() * (MERCHANT_PURSE_MAX - MERCHANT_PURSE_MIN + 1)) };
      // One standing request per trader, rolled with him. Meeting a second
      // trader is how you get a second errand, which is what keeps them worth
      // walking towards after you have bought everything you need.
      mob.request = rollRequest(rng);
    }
    if (spec.lamp) {
      // The only warm light on the planet that walks. Positioned in model units
      // — the root's scale is rewritten every frame by _animate, so anything
      // measured in cells here would be scaled twice.
      const lamp = new THREE.PointLight(0xffcf8a, 2.4, 8, 2);
      lamp.position.set(0, MobModels.modelHeight(url) * 1.15, 0);
      model.root.add(lamp);
    }
    this.list.push(mob);
    this._sync(mob);
    mob.prevPos.copy(mob.pos);
    mob.progAt.copy(mob.pos);
    this._animate(mob, 0);   // place the model now; never render at the origin
    return mob;
  }

  /**
   * Which animal belongs on this ground. Only the cold-weather rule is applied
   * — a penguin on a savanna is the one mismatch obvious enough to matter, and
   * a full biome table would be a lot of bookkeeping for little gain.
   */
  _pickWildlife(col) {
    return this._drawFrom(col, false);
  }

  /** Which flier belongs on this ground, or null if none does. */
  _pickFlier(col) {
    return this._drawFrom(col, true);
  }

  /** How many monsters are abroad, counted rather than tracked. */
  _countMonsters() {
    let n = 0;
    for (const m of this.list) if (m.spec.monster) n++;
    return n;
  }

  /**
   * One monster on this ground, if this biome has any.
   *
   * Keyed off the biome rather than the block underfoot, for the reason the
   * wildlife draw gives: a patch of sand inside a forest is a riverbank, not a
   * desert. A biome absent from the table spawns nothing, which is how the
   * meadow stays safe.
   */
  _spawnMonster(col, k) {
    const list = MONSTER_BY_BIOME[BIOME_NAME[this.planet.colBiome[col]]];
    if (!list || !list.length) return false;
    // Never in the opening clearing. A monster is the one thing that should
    // not be waiting for a player who has just been handed six torches.
    if (this._nearHome(col, k)) return false;
    const type = list[(Math.random() * list.length) | 0];
    return !!this.spawn(type, col, k);
  }

  /**
   * The biome's list, and one species drawn from the half of it that flies or
   * the half that does not.
   *
   * The biome, not the block underfoot. Asking the block was enough while the
   * only rule was "penguins on ice", and gets steadily wronger as the rules get
   * more specific: a patch of sand inside a forest is a riverbank, not a desert,
   * and the biome field already knows that.
   *
   * Splitting the draw is what gives bees their own budget without a second
   * table to keep in step with the first. SPAWN_BY_BIOME stays the single
   * statement of which biomes have bees in them; it simply stops being the thing
   * that rations them, because a bee that has to win a one-in-twelve draw
   * against eleven land animals for a slot in the land budget is a bee you see
   * about once a session. Reservoir-sampled so the draw is uniform over the
   * matching entries in one pass and without allocating a filtered list — the
   * same trick _findDarkColumn uses on its pockets.
   */
  _drawFrom(col, wantFlier) {
    const list = SPAWN_BY_BIOME[BIOME_NAME[this.planet.colBiome[col]]] || COMMON;
    // Weighted reservoir, which is the same one-pass trick with the running
    // count replaced by a running total: an entry wins the slot with
    // probability (its weight / everything seen so far), and that leaves each
    // entry holding it in proportion to its weight at the end. Still one pass,
    // still no filtered list allocated, and the weights are the only thing
    // that changed — see spawnWeight for what they are and why they are not
    // written into the tables by hand.
    let pick = null, total = 0;
    for (let n = 0; n < list.length; n++) {
      const spec = SPECIES[list[n]];
      if (!spec || !!spec.flies !== wantFlier) continue;
      total += spec.spawnWeight;
      if (Math.random() < spec.spawnWeight / total) pick = list[n];
    }
    return pick;
  }

  /**
   * How many of each population is alive, in one pass.
   *
   * Three counters rather than three loops, and three budgets rather than one:
   * a fish and a bee are not competing with a cow for anywhere to stand, so
   * making them compete for the same number was only ever arithmetic. Husks and
   * the merchant are counted by _countHostile and merchant() against their own
   * caps and are excluded here.
   */
  _census() {
    let land = 0, water = 0, air = 0;
    for (const m of this.list) {
      if (m.spec.hostile || m.spec.monster || m.spec.trader || m.spec.phantom) continue;
      if (m.spec.aquatic) water++;
      else if (m.spec.flies) air++;
      else land++;
    }
    return { land, water, air };
  }

  /**
   * Send some of the herd to bed, out of sight.
   *
   * The same removal the despawn ring uses — `_release` and a splice, no death,
   * no drops, no sound. An animal that walks off the edge of the simulation and
   * one that has bedded down for the night are the same event to everything
   * downstream, and giving the night its own kind of removal would mean a
   * second path to keep in step with the first.
   *
   * Furthest first, and never inside NIGHT_BED_DIST. Taking the nearest would
   * be cheaper and is exactly wrong: the animals a player can see are the ones
   * whose disappearance they would notice, and "the deer I was walking towards
   * blinked out" is a bug report, not a nightfall.
   *
   * Fish are exempt for the reason given at the call site, and so are anything
   * hostile, the merchant, and — the one that matters — anything the player has
   * bred or is chasing right now. A tamed or fleeing animal vanishing is the
   * player's work being deleted.
   *
   * @param {object} player
   * @param {number} surplus how many are over the night budget
   */
  _bedDown(player, landSurplus, airSurplus) {
    // Two budgets, counted separately, because they are separate budgets.
    //
    // This took one number — the two surpluses added together — and then chose
    // what to remove by distance alone, which was wrong twice over.
    //
    // It let a flier surplus be paid for with land animals. The land top-up
    // runs four lines earlier and fills its own budget exactly, so the land term
    // is always zero at this point; any surplus is bees, and the furthest body
    // is usually one of the land animals the top-up has just placed out in the
    // far ring. The result was a spawn/despawn treadmill — animals created and
    // retired within seconds of each other, about one a second, until the flier
    // count ground down. That is what a monkey spawned for a test being gone
    // moments later actually was.
    //
    // And the sum was signed, so a night with no bees at all — `air - airCap`
    // of -7 — quietly raised the land ceiling by seven and held it there.
    let land = Math.max(0, landSurplus | 0);
    let air = Math.max(0, airSurplus | 0);
    if (land + air <= 0) return;
    let want = Math.min(land + air, NIGHT_BED_PER_TICK);
    while (want > 0) {
      let far = -1, farD = NIGHT_BED_DIST, farFlier = false;
      for (let n = 0; n < this.list.length; n++) {
        const m = this.list[n];
        const s = m.spec;
        if (s.hostile || s.monster || s.trader || s.aquatic || s.phantom) continue;
        // Only from a category that is actually over its own budget.
        const flier = !!s.flies;
        if (flier ? air <= 0 : land <= 0) continue;
        // `state === 'flee'` and not a `fleeing` flag — there is no such flag,
        // and a guard naming one would have read as protection while doing
        // nothing at all.
        if (m.dying > 0 || m.baby > 0) continue;
        if (m.state === 'flee' || m.state === 'chase' || m.target) continue;
        const d = m.pos.distanceTo(player.position);
        if (d > farD) { farD = d; far = n; farFlier = flier; }
      }
      if (far < 0) return;         // nothing far enough; try again next tick
      this._release(this.list[far]);
      this.list.splice(far, 1);
      if (farFlier) air--; else land--;
      want--;
    }
  }

  /**
   * Spawn whatever belongs on this ground, if anything does.
   *
   * The shoreline test lives here rather than in the biome tables because it is
   * about the *column*, not the biome: BEACH and OCEAN are both full of columns
   * a crab has no business on, twenty in from the water line, and a river
   * cutting through a forest is a shore that no biome name mentions. Refusing
   * the spawn is better than picking again — the next tick is 2.5 seconds away
   * and the budget is not tight enough for one wasted slot to show.
   *
   * @returns {boolean} true if something was actually placed
   */
  _spawnWild(col, k) {
    // The opening clearing — see CALM_RADIUS. Draw again rather than refuse
    // outright: a straight refusal would leave the first forty units of a new
    // world visibly emptier than everywhere else, which is a different
    // complaint about the same ground. Three passes and then give up, because
    // a biome whose entire land list is large would otherwise spin — there is
    // no such biome today, but the tables are data and this is not the place to
    // find that out.
    const calm = this._nearHome(col, k);
    let type = null;
    for (let t = 0; t < (calm ? 3 : 1) && !type; t++) {
      const pick = this._pickWildlife(col);
      // Null means this biome's whole list flies — nothing does today, but the
      // draw can return it and a silent SPECIES[null] would spawn nothing while
      // reporting success, which is the kind of thing that shows up later as a
      // budget that never fills.
      if (!pick) return false;
      if (!calm || isCalm(SPECIES[pick])) type = pick;
    }
    if (!type) return false;
    const spec = SPECIES[type];
    if (spec?.shore && !this._nearWater(col, SHORE_NEAR)) return false;
    return !!this.spawn(type, col, k);
  }

  /**
   * @param {boolean|undefined} cave count only cave-born (true) or only
   *   surface-born (false) hostiles; omit for the total.
   */
  _countHostile(cave) {
    let n = 0;
    for (const m of this.list) {
      if (!m.spec.hostile) continue;
      if (cave !== undefined && !!m.fromCave !== cave) continue;
      n++;
    }
    return n;
  }

  // --- the stalker ----------------------------------------------------------

  /** How many are abroad. There is never more than one, and this is why. */
  _countStalkers() {
    let n = 0;
    for (const m of this.list) if (m.spec.phantom) n++;
    return n;
  }

  /**
   * The point on a body that decides whether it is being looked at.
   *
   * The head and not the feet, and not the centre either. Feet spend half their
   * life behind the lip of whatever the body is standing on, so a line-of-sight
   * test aimed at them says "occluded" about a figure whose whole upper half is
   * against the sky — which for this mob does not mean a wrong shadow, it means
   * he is deleted.
   */
  _headOf(mob, out) {
    return out.copy(mob.pos).addScaledVector(mob.up, mob.spec.height * 0.85);
  }

  /**
   * Is there a clear line from `from` to `to` through the voxels?
   *
   * A fixed-step walk rather than planet.raycast, which marches at 0.045 and
   * would be two thousand samples across a sighting. Nothing here needs to know
   * *which* block interrupts the line or where the face is — only whether one
   * does — so the step can be most of a block wide. LOS_STEP is under one so no
   * single block can sit entirely between two samples.
   *
   * Cross plants are not solid, which is the right answer for both of the
   * places it matters: a stalker standing in waist-high grass is visible, and a
   * stalker behind a trunk is not.
   *
   * Everything IS_SOLID says yes to fills its whole cell here, including the
   * ones that visibly do not — a fence, a pane of glass, a slab. That is the
   * same notion of solid the footprint test, the pathing and the ground scans
   * all use, and a second one just for sight lines would be a second thing to
   * keep in step. What it costs, measured: one course of fence or one lower
   * slab still lets a blow through (the head-to-head ray clears it, 26 blows in
   * 30s, exactly the open-ground rate), but two courses of either stop one, and
   * so does a glass wall. Two stacked lower slabs leave a real 0.5-cell gap at
   * head height and are read as closed. All three are deliberate builds a
   * player put up to stand behind, so reading them as cover is at worst
   * generous in the direction shelter is supposed to work.
   *
   * The step and the end margin are arguments because there are now two
   * calibrations of the same walk and only one walk should exist. A sighting
   * runs tens of cells and can afford to be coarse; a blow runs one or two and
   * cannot. The clamp below is the floor under both — see BLOW_STEP for why a
   * blow wants more than that floor.
   *
   * @param {number} step sample spacing, in world units.
   * @param {number} skip how far short of `to` to stop.
   */
  _lineOfSight(from, to, step = LOS_STEP, skip = 0.4) {
    _los.copy(to).sub(from);
    const len = _los.length();
    if (len < 1e-3) return true;
    _los.multiplyScalar(1 / len);
    // A step is never allowed to be longer than the line it is walking. Without
    // this, `step` and `skip` together can skip the walk entirely: at LOS_STEP
    // and 0.4 a line 1.10 long takes its first sample at 0.85, which is already
    // past 0.70, so the loop never runs and a solid metre of stone reads as
    // clear. That was measured — a husk pressed to one face of a wall and a
    // player pressed to the other are 1.10 apart, and the sight test said it
    // could see them. Three samples over whatever interior the line has costs
    // nothing on a short line and never triggers on a long one.
    const s = Math.min(step, (len - skip) / 3);
    if (s <= 0) return true;
    // Start clear of the observer and stop clear of the target: the first
    // sample would otherwise be inside the camera's own block on a bad frame,
    // and the last inside the body we are asking about.
    for (let t = s; t < len - skip; t += s) {
      if (this.planet.isSolidWorld(
        from.x + _los.x * t, from.y + _los.y * t, from.z + _los.z * t,
      )) return false;
    }
    return true;
  }

  /**
   * Can this body actually land a blow on that one, or is there terrain in the
   * way?
   *
   * The reported bug, and the whole of it: `reach` was a distance between two
   * centres and asked nothing about what lay between them. A husk's reach is
   * 1.25 plus its radius; a wall is one block thick; the player standing half a
   * cell from one face and the husk half a cell from the other are inside that
   * number, so the husk hit through the wall — which removes the point of
   * building a shelter. A fox at 1.26 does the same to a rabbit, which is the
   * case that was measured.
   *
   * Three rays, not one, and it is clear if ANY of them is:
   *
   *   mid to mid    the ordinary case, and the one that answers first in the
   *                 open, so the ordinary case costs one march.
   *   head to head  over a low lip. A one-block step between two tall bodies is
   *                 not cover and should not read as cover; a wall built to
   *                 head height blocks this ray as well as the first.
   *   mid to shins  down into a dip. Without it, standing on a rim and biting
   *                 something in a one-deep hollow reads as blocked, because
   *                 the mid-to-mid line clips the rim.
   *
   * Heights are fractions of `spec.height`, and the source uses the same 0.85
   * as `_headOf` for the head so a body has one idea of where its head is.
   *
   * Cost is the point of the constants: BLOW_STEP is fine enough that no
   * one-cell-thick wall can fall between two samples, and the lines are one to
   * three cells long, so a march is four to twelve `isSolidWorld` lookups. It
   * runs on the decision to swing and again at the contact frame — per hostile
   * per swing, not per frame — plus once per predator bite. Measured in the
   * harness: see the report.
   *
   * The step and skip are arguments for the same reason `_lineOfSight` takes
   * them: the three-ray shape is the right question at both ranges, and only
   * the sampling wants to differ. A blow is one to three cells and marches at
   * BLOW_STEP; an *acquisition* — the prey search reaches 20 cells, the fright
   * ring 11, the night stalk 26 — would be a seventy-sample march per ray at
   * that spacing, so `_sightClear` walks it at LOS_STEP instead. Nothing is
   * lost by the coarser walk: `_lineOfSight`'s own clamp guarantees at least
   * three samples on any line, which is what stops a one-cell wall falling
   * between two of them on a short one.
   *
   * @param {number} th the target's full height, in cells.
   */
  _blowClear(mob, pos, up, th, step = BLOW_STEP, skip = BLOW_SKIP) {
    const sh = mob.spec.height;
    for (let n = 0; n < BLOW_RAYS.length; n += 2) {
      _ptA.copy(mob.pos).addScaledVector(mob.up, sh * BLOW_RAYS[n]);
      _ptB.copy(pos).addScaledVector(up, th * BLOW_RAYS[n + 1]);
      if (this._lineOfSight(_ptA, _ptB, step, skip)) return true;
    }
    return false;
  }

  /**
   * The same three rays, at sighting range and sighting cost.
   *
   * Every place a body *chooses* something — the prey search, the fright scan,
   * the night stalk's roll — as opposed to swinging at something it has already
   * chosen. Measured before this existed: a fox behind six blocks of stone held
   * a rabbit as prey on 3350 frames of 3600 and paced the wall for the whole
   * minute, a bunny bolted from a tiger it could not see on 1444 frames of
   * 3600, and a tiger telegraphed a night stalk at a player sealed in a stone
   * pocket for two solid minutes — every one of those numbers identical to the
   * same pair on open ground, i.e. the wall was doing nothing at all.
   */
  _sightClear(mob, pos, up, th) {
    return this._blowClear(mob, pos, up, th, LOS_STEP, 0.4);
  }

  /**
   * Can this body land a blow on the player?
   *
   * Separate only because the player is not a mob: feet at `position`, up at
   * `up`, and a fixed height that Mobs has no other reason to know.
   */
  _blowClearPlayer(mob, player) {
    return this._blowClear(mob, player.position, player.up, PLAYER_HEIGHT);
  }

  /**
   * Is this body inside the camera's frame right now, and not behind anything?
   *
   * The camera is used rather than the player, and the two are genuinely not
   * the same question in third person: the body stands in front of a camera
   * that is several units behind it, and what the *player* can see is what the
   * camera can see. This is also last frame's camera — update() runs before
   * updateCamera — which is not a lag to be fixed. Last frame's camera is
   * precisely the view that was rendered, i.e. the one the player actually
   * looked at.
   *
   * @param {number} margin how far outside the frame still counts as seen, in
   *   normalised device coordinates. 1 is the exact edge of the screen.
   */
  _inView(mob, margin) {
    const cam = this.camera;
    // Nobody is looking. Not "assume they are" — see the note on `this.camera`.
    if (!cam) return false;
    const e = cam.matrixWorld.elements;
    this._headOf(mob, _eye);
    // In front of the lens at all. The projective divide below flips the sign
    // of everything behind the camera, so a body directly at your back lands
    // inside the frame with every coordinate negated and reads as visible. This
    // is the single test that stops "turn around" being the one direction he
    // survives.
    _seen.set(-e[8], -e[9], -e[10]);
    if (_los.copy(_eye).sub(cam.position).dot(_seen) <= 0) return false;
    _vpm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _ndc.copy(_eye).applyMatrix4(_vpm);
    if (Math.abs(_ndc.x) > margin || Math.abs(_ndc.y) > margin) return false;
    if (_ndc.z > 1) return false;             // beyond the far plane
    return this._lineOfSight(cam.position, _eye);
  }

  /**
   * The whole of "he is gone the next time you look", in one predicate.
   *
   * Three ways to stop being a sighting, and they are three because each closes
   * a different way the illusion ends:
   *
   *   - not observed. The one the request is actually about.
   *   - too close. The backstop on never being caught, and the reason that is
   *     a guarantee rather than a tuning exercise.
   *   - out of time. A player who spots him and simply keeps staring would
   *     otherwise hold him on the ridge forever, and a figure you can stand and
   *     study is a mob.
   */
  _unobserved(mob, dist) {
    if (mob.hauntT <= 0) return true;
    if (dist < STALKER_VANISH) return true;
    return !this._inView(mob, STALKER_MARGIN);
  }

  /**
   * Ground for a sighting: far, on the surface, inside the frame and off to one
   * side of it, with a clear line to the eye.
   *
   * Deliberately not `_findSpawnColumn` with different numbers. That one's job
   * is the opposite of this one's — it exists to place bodies *outside* the
   * view so nothing is seen to pop in, and the whole point here is that he must
   * be seen, or the despawn takes him on the very next frame and the sighting
   * never happens at all. The terrain half of the test is the same and is
   * repeated rather than shared, because a parameter that inverts the meaning
   * of a function is how one function becomes two functions in a trench coat.
   */
  _findStalkerSpot(nearCol, playerPos) {
    const p = this.planet;
    if (!this.camera) return null;
    for (let tries = 0; tries < 24; tries++) {
      const steps = STALKER_STEPS_MIN + Math.floor(Math.random() * STALKER_STEPS_SPAN);
      const col = this._walkOut(nearCol, steps);
      const k = p.surfaceK(col);
      if (k < 0 || k > D - 6) continue;
      const surf = p.at(col, k);
      if (surf !== ID.grass && surf !== ID.sand && surf !== ID.snow) continue;
      if (p.solidAt(col, k + 1) || p.solidAt(col, k + 2)) continue;
      if (p.liquidAt(col, k + 1) || p.liquidAt(col, k + 2)) continue;
      // A hearth is a place the player has made safe. Whatever else he is, he
      // is not something that stands in the firelight.
      if (this._warded(col, k)) continue;
      if (this._nearHome(col, k)) continue;
      const { f, i, j } = colParts(col);
      cellToWorld(f, i + 0.5, j + 0.5, k + 1, _p);
      _eye.set(_p[0], _p[1], _p[2]);
      const d = _eye.distanceTo(playerPos);
      if (d < STALKER_NEAR || d > STALKER_FAR) continue;
      // Where his head will be, which is what has to clear the terrain and
      // what has to be on screen — his feet are behind the ridge by design.
      // The local up is the outward radial on a sphere, which is what `_sync`
      // would give this body once it existed — and it does not exist yet.
      _eye.addScaledVector(_rel.copy(_eye).normalize(), SPECIES.stalker.height * 0.85);
      const cam = this.camera;
      const e = cam.matrixWorld.elements;
      _seen.set(-e[8], -e[9], -e[10]);
      if (_los.copy(_eye).sub(cam.position).dot(_seen) <= 0) continue;
      _vpm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      _ndc.copy(_eye).applyMatrix4(_vpm);
      const ax = Math.abs(_ndc.x);
      if (ax < STALKER_EDGE_MIN || ax > STALKER_EDGE_MAX) continue;
      if (Math.abs(_ndc.y) > 0.75 || _ndc.z > 1) continue;
      if (!this._lineOfSight(cam.position, _eye)) continue;
      return { col, k };
    }
    return null;
  }

  /**
   * What he does while he is being looked at: watch, and back away.
   *
   * Returns true unconditionally, so the wander, the flee and the grazing state
   * machine all stand down — he has exactly one thing on his mind and it is the
   * player. Note that he only ever writes `want`; the heading is still the
   * turn-limited one every other body uses, so he swings round to face you at a
   * human rate instead of snapping.
   *
   * There is no path search here and there should not be. _findPath and _stepTo
   * exist to get a hunter *to* the player; this one is trying to be somewhere
   * else, and a retreat that walks into a wall and stands there is fine —
   * better than fine. He is not supposed to escape convincingly. He is supposed
   * to not be there.
   */
  _haunt(mob, dt, dist, player, fr) {
    mob.hauntT -= dt;
    _rel.copy(player.position).sub(mob.pos);
    const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
    const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
    const toPlayer = Math.atan2(rb, ra);
    if (dist < STALKER_RUN) {
      // Close enough to be walked up to, so he leaves. `flee` rather than
      // `walk` for the speed and the turn rate, and it costs nothing else: the
      // only other thing that reads `state === 'flee'` is _bedDown, which
      // already skips him.
      mob.want = wrapAngle(toPlayer + Math.PI);
      mob.state = 'flee';
      mob.stateT = 1;
    } else {
      // Standing still and facing you is the whole performance at distance. A
      // figure walking about on a ridge is a villager; a figure that is simply
      // stopped, turned your way, is the thing being asked for.
      mob.want = toPlayer;
      mob.state = 'idle';
      mob.stateT = 1;
    }
    return true;
  }

  /**
   * A roofed, unlit pocket to put a husk in — a cave, a ravine, the inside of a
   * badly-lit build. Sky exposure is judged by looking straight up through the
   * column: the real light field lives in the meshing worker and is never sent
   * back, so this is the honest approximation available on this side.
   */
  _findDarkColumn(nearCol, playerPos) {
    const p = this.planet;
    for (let tries = 0; tries < 26; tries++) {
      // A cave husk only has to be out of sight, and underground that is what
      // rock is for — the surface ring is far too wide down here. Searching
      // 18-40 columns out and then refusing anything within 20 units meant
      // hunting for a *second* cave beyond the one the player was standing in,
      // and caves are not that common: a player 24 blocks down saw not one husk
      // in 45 seconds. A tunnel bending away ten blocks on is out of sight.
      const col = this._walkOut(nearCol, CAVE_WALK_MIN
        + Math.floor(Math.random() * CAVE_WALK_SPAN));
      const surf = p.surfaceK(col);
      if (surf < 4) continue;

      // Scan the column for a pocket rather than probing one random layer.
      // Rock is most of what is down there — a uniform probe landed inside
      // solid stone 856 times in 900, so this search used to fail on terrain
      // long before it ever got as far as the distance test. Walking the column
      // finds the cave if the column has one, which is the actual question.
      const top = Math.min(surf - 2, D - 3);
      const pockets = [];
      for (let k = 2; k <= top; k++) {
        if (!p.solidAt(col, k)) continue;                              // needs a floor
        if (p.solidAt(col, k + 1) || p.solidAt(col, k + 2)) continue;  // and headroom
        if (p.liquidAt(col, k + 1) || p.liquidAt(col, k + 2)) continue;
        pockets.push(k);
      }
      if (!pockets.length) continue;

      // Choose among the *roofed* pockets, rather than choosing one at random
      // and then testing it. A column often holds both a cave and the open
      // ground above it; picking blind meant landing on the surface pocket and
      // throwing the whole column away. That rejected a valid cave in 32% of
      // all tries — more than any other cause except columns with no pocket at
      // all — and left cave husks spawning at a rate of about one per 400s.
      let k = -1, seen = 0;
      for (let n = 0; n < pockets.length; n++) {
        if (!this._roofed(col, pockets[n] + 1)) continue;
        seen++;
        if (Math.random() < 1 / seen) k = pockets[n];   // reservoir sample
      }
      if (k < 0) continue;
      const { f, i, j } = colParts(col);
      cellToWorld(f, i + 0.5, j + 0.5, k + 1, _p);
      const d = Math.hypot(_p[0] - playerPos.x, _p[1] - playerPos.y, _p[2] - playerPos.z);
      if (d < CAVE_MIN_DIST || d > DESPAWN_RADIUS - 25) continue;
      // Light keeps them out. This is checked last because it is the most
      // expensive test and the cheap ones reject most candidates first.
      if (this._litNear(col, k + 1)) continue;
      if (this._warded(col, k)) continue;
      return { col, k };
    }
    return null;
  }

  /**
   * A blocked hunter looks for a way through: a fan of headings either side of
   * the bearing to its target, tested a body-length ahead, best angle wins.
   *
   * This is deliberately not pathfinding. A* over a quarter of a million
   * columns is a subsystem, and the movement code in this file has a long
   * history of being broken by clever additions. A whisker fan is local, costs
   * a handful of footprint tests only on the frames a hunter is actually stuck,
   * and is enough for the case that matters: rounding a corner and finding the
   * gap in a wall. It cannot solve a maze, and is not meant to.
   *
   * @returns {number|null} a heading to steer to, or null if every way is barred
   */
  _probeAround(mob, c, here, fr, player, aim) {
    let toTarget = aim;
    if (toTarget === undefined) {
      _rel.copy(player.position).sub(mob.pos);
      const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
      const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
      toTarget = Math.atan2(rb, ra);
    }
    const reach = mob.halfL * 2 + PROBE_AHEAD;

    let best = null, bestTurn = Infinity;
    for (let n = 0; n < PROBE_ANGLES.length; n++) {
      const turn = PROBE_ANGLES[n];
      if (Math.abs(turn) >= bestTurn) continue;      // already have a straighter one
      const h = wrapAngle(toTarget + turn);
      const ni = c.ci + Math.cos(h) * reach;
      const nj = c.cj + Math.sin(h) * reach;
      if (this._footprintCost(c.f, ni, nj, here, mob, h) !== 0) continue;
      best = h;
      bestTurn = Math.abs(turn);
    }
    return best;
  }

  /**
   * Is anything burning near this cell?
   *
   * Two comments in this file already claimed torches were "what makes a torch
   * worth carrying", and the spawn search did not read light at all: a mine lit
   * end to end kept producing husks exactly as fast as a black one, so a torch
   * bought you visibility and nothing else. The real light field is built in the
   * meshing worker and never sent back, so this walks the blocks instead and
   * asks the only question that matters — has the player put a light here.
   *
   * Every column, not every other one. Sampling in steps of two looks like a
   * fair approximation and is not: it is a parity filter, so a torch at an odd
   * offset is invisible from an even-offset candidate however close it is.
   * Measured, a torch five columns from the pocket it was meant to protect read
   * as no torch at all. This runs only on candidates that have already passed
   * every cheaper test, so the full scan costs nothing worth saving.
   */
  /**
   * Is this spot inside the light of a hearth?
   *
   * Only *spawning* is refused. A husk already following you walks right into
   * the ward and swings — a safe base means one that nothing appears inside,
   * not one with an invisible wall around it.
   */
  _warded(col, k) {
    const wards = this.wards;
    if (!wards || !wards.length) return false;
    const { f, i, j } = colParts(col, _wp);
    cellToWorld(f, i + 0.5, j + 0.5, k + 1, _p);
    const r = this.wardRadius || 0;
    for (let n = 0; n < wards.length; n++) {
      const w = wards[n];
      if (Math.hypot(_p[0] - w.x, _p[1] - w.y, _p[2] - w.z) < r) return true;
    }
    return false;
  }

  /**
   * Is this spot inside the opening clearing?
   *
   * Modelled on _warded, including the part that matters most: only *spawning*
   * is refused. A lion that walks in from the plain is welcome, and one already
   * standing there stays. A clearing that pushed bodies out of itself would be
   * an invisible fence around the spawn point, which is a stranger thing to
   * explain than a lion.
   *
   * `homePos` is null on a loaded save — populate() is the only thing that sets
   * it and only a new world calls it — so the rule is simply inactive there.
   * That is the right answer rather than an omission: a returning player has
   * moved in, and the clearing they woke up in years ago has stopped meaning
   * anything.
   */
  _nearHome(col, k) {
    const h = this.homePos;
    if (!h) return false;
    const { f, i, j } = colParts(col, _wp);
    cellToWorld(f, i + 0.5, j + 0.5, k + 1, _p);
    return Math.hypot(_p[0] - h.x, _p[1] - h.y, _p[2] - h.z) < CALM_RADIUS;
  }

  _litNear(col, k) {
    const p = this.planet;
    for (let dk = -LIGHT_GUARD_K; dk <= LIGHT_GUARD_K; dk++) {
      const kk = k + dk;
      if (kk < 1 || kk >= D - 1) continue;
      for (let di = -LIGHT_GUARD; di <= LIGHT_GUARD; di++) {
        for (let dj = -LIGHT_GUARD; dj <= LIGHT_GUARD; dj++) {
          const id = p.at(stepColumn(col, di, dj), kk);
          // Lava is excluded on purpose. It emits light 15, and the mantle is
          // full of it — counting it sterilised the entire cave layer: 200 of
          // the 201 candidates that got this far were rejected for lava glow
          // and nothing spawned underground at all. It is also the wrong rule
          // for the player: the mechanic they are taught is "light your mine
          // and it stays yours", and a lava lake making a cavern safe is
          // neither intuitive nor something they chose. Husks by the lava is a
          // better cave than husks nowhere.
          if (LIGHT_EMIT[id] > 0 && RENDER_TYPE[id] !== R_LIQUID) return true;
        }
      }
    }
    return false;
  }

  /**
   * Open ground for a merchant to walk in from: out of sight, but not so far
   * it is culled again on the next tick. Deliberately further out than ordinary
   * wildlife — you should come across a merchant, not have one appear beside you.
   */
  _findMerchantColumn(nearCol, playerPos) {
    const p = this.planet;
    for (let tries = 0; tries < 24; tries++) {
      // Further out than the herd, and derived rather than guessed for the same
      // reason: it should arrive from beyond where the animals do, and "beyond
      // where the animals do" is a distance, not a step count.
      const col = this._walkOut(nearCol, stepsFor(50)
        + Math.floor(Math.random() * (stepsFor(80) - stepsFor(50))));
      const k = p.surfaceK(col);
      if (k < 0 || k > D - 6) continue;
      const surf = p.at(col, k);
      if (surf !== ID.grass && surf !== ID.sand && surf !== ID.snow) continue;
      if (p.solidAt(col, k + 1) || p.solidAt(col, k + 2)) continue;
      if (p.liquidAt(col, k + 1) || p.liquidAt(col, k + 2)) continue;
      const { f, i, j } = colParts(col);
      cellToWorld(f, i + 0.5, j + 0.5, k + 1, _p);
      const d = Math.hypot(_p[0] - playerPos.x, _p[1] - playerPos.y, _p[2] - playerPos.z);
      if (d < SPAWN_MIN_DIST || d > DESPAWN_RADIUS - 30) continue;
      return { col, k };
    }
    return null;
  }

  /**
   * Is the player swimming, as opposed to standing in shallow water?
   *
   * `inWater` on its own is read at the player's feet, so it is true of a
   * puddle and of every ford on the planet — gating a predator on it alone
   * would make stepping into an inch of stream a way to call off a tiger.
   * `grounded` is false exactly when there is nothing under the feet, which is
   * the difference between being out of your depth and wading.
   *
   * Read off the flags the player already maintains rather than recomputed
   * from the terrain here: two answers to one question drift apart, and the
   * player's own are the ones its movement is actually obeying.
   */
  _playerAfloat(player) {
    return !!player.inWater && !player.grounded;
  }

  /** Is this column's surface under water? */
  _isWater(col) {
    const k = this.planet.surfaceK(col);
    return k >= 0 && this.planet.liquidAt(col, k + 1);
  }

  /**
   * Which way the water is, for an animal that wants to stay near it.
   *
   * Eight compass directions sampled outward until one of them hits water, and
   * the answer is a heading because that is what the steering wants: `vel.i` is
   * cos(heading) and `vel.j` is sin(heading), so a column offset of (di, dj) is
   * simply atan2(dj, di) in the animal's own tangent frame — no world-space
   * round trip and nothing to get wrong at a cube seam.
   *
   * Returns null both when there is no water within reach and when the animal
   * is already at the water's edge. Those are the same answer to the only
   * question being asked — should I be pulled anywhere? — and collapsing them
   * keeps the caller from having to know the difference.
   *
   * At most 8 x 8 column reads, and only for `shore` species, and only when one
   * of them picks a new wandering heading. That is a few dozen lookups every
   * few seconds per crab.
   */
  _shoreBearing(mob) {
    const col = this._colOf(mob.cell.f, mob.cell.ci, mob.cell.cj);
    for (let s = SHORE_STEP; s <= SHORE_PULL; s += SHORE_STEP) {
      for (let n = 0; n < 8; n++) {
        const di = RING8[n * 2] * s, dj = RING8[n * 2 + 1] * s;
        if (!this._isWater(stepColumn(col, di, dj))) continue;
        return s <= SHORE_NEAR ? null : Math.atan2(dj, di);
      }
    }
    return null;
  }

  /** Is there water within `r` columns? Used to keep shore animals on a shore. */
  _nearWater(col, r) {
    if (this._isWater(col)) return true;
    for (let s = SHORE_STEP; s <= r; s += SHORE_STEP) {
      for (let n = 0; n < 8; n++) {
        if (this._isWater(stepColumn(col, RING8[n * 2] * s, RING8[n * 2 + 1] * s))) return true;
      }
    }
    return false;
  }

  /** Layer of the water surface at or above k — where a fish must stop rising. */
  /**
   * How deep water may be before this body is out of its depth, in cells.
   *
   * Off the drawn height rather than `tall`, which is that height rounded up
   * into whole blocks of headroom: a husk and a cow both need two, and they are
   * not the same animal in water. See WADE_STAND.
   */
  _wadeDepth(mob) {
    const h = (mob.baseHeight ?? mob.spec.height) * (mob.grown ?? 1);
    return Math.min(WADE_STAND_MAX, h * WADE_STAND);
  }

  /**
   * Is the water over `gk` in this column shallow enough for `mob` to stand up
   * in — i.e. is this a ford rather than the drink?
   *
   * Counted in whole layers, because water is: one block of it is one deep.
   * `wade` is passed in rather than recomputed because the caller asks this of
   * up to nine columns in a row and the answer does not vary between them.
   */
  _fordable(col, gk, wade) {
    if (wade <= 0) return false;
    // No bed under it at all: whatever this body is doing, it is not standing.
    if (gk < 0) return false;
    if (!this.planet.liquidAt(col, gk + 1)) return true;   // not wet at all
    if (this.planet.at(col, gk + 1) === ID.lava) return false;
    return this._waterTop(col, gk + 1) - gk <= wade;
  }

  _waterTop(col, k) {
    let top = k;
    while (top + 1 < D && this.planet.liquidAt(col, top + 1)) top++;
    return top;
  }

  /**
   * A layer in this column a fish could hold station in, or -1.
   *
   * Two deep, not three. Three was written for the open sea and it quietly
   * excluded almost every inland lake and every river on the planet — which is
   * the other half of "a lake with nothing in it", since the lake was never a
   * candidate in the first place. Two layers is still enough water for the
   * buoyancy in update() to work with: the fish sits at bed + ~1.0 and the
   * ceiling test holds it under bed + 1.4, so it swims rather than skimming the
   * surface or scraping the bed.
   */
  _waterLayer(col) {
    const p = this.planet;
    let bed = -1;
    for (let k = D - 1; k > 1; k--) if (p.solidAt(col, k)) { bed = k; break; }
    if (bed < 1) return -1;
    let depth = 0;
    while (bed + 1 + depth < D && p.liquidAt(col, bed + 1 + depth)) depth++;
    if (depth < 2) return -1;
    return bed + Math.floor(depth * 0.4);
  }

  /** How many layers of water stand over the bed here, or 0 if none. */
  _waterDepth(col) {
    const p = this.planet;
    let bed = -1;
    for (let k = D - 1; k > 1; k--) if (p.solidAt(col, k)) { bed = k; break; }
    if (bed < 1) return 0;
    let depth = 0;
    while (bed + 1 + depth < D && p.liquidAt(col, bed + 1 + depth)) depth++;
    return depth;
  }

  /**
   * Which fish belongs in this column, decided by how deep the water is.
   *
   * Depth rather than biome, because the shelf and the abyss beside it are the
   * same biome and the difference that matters to an anglerfish is the one the
   * map does not record. A shark wants room to be a shark, so it takes the same
   * threshold; a piranha is a river fish and takes any water that will hold a
   * shoal.
   */
  _pickFish(col) {
    const depth = this._waterDepth(col);
    if (depth >= DEEP_WATER) {
      const r = Math.random();
      if (r < 0.06) return 'shark';
      if (r < 0.34) return 'deep_fish';
      return 'fish';
    }
    return Math.random() < 0.04 ? 'piranha' : 'fish';
  }

  /** Open water deep enough for the fish. */
  _findWaterColumn(nearCol, playerPos) {
    for (let tries = 0; tries < 44; tries++) {
      // Evenly over the water's AREA, on the same reasoning as the land search
      // — see spawnDist. A lake at the far edge of the ring is as much water as
      // one at the near edge and was getting a fraction of the shoals.
      const col = this._walkTo(nearCol, spawnDist(playerPos ? SPAWN_MIN_DIST : SEED_NEAR, SPAWN_FAR));
      const k = this._waterLayer(col);
      if (k < 0) continue;
      if (playerPos) {
        const { f, i, j } = colParts(col);
        cellToWorld(f, i + 0.5, j + 0.5, k + 1, _p);
        const d = Math.hypot(_p[0] - playerPos.x, _p[1] - playerPos.y, _p[2] - playerPos.z);
        if (d < SPAWN_MIN_DIST || d > DESPAWN_RADIUS - 25) continue;
      }
      return { col, k };
    }
    return null;
  }

  /**
   * Put a shoal of fish in one stretch of water.
   *
   * The search is the expensive half — a random walk repeated until it lands in
   * water — so finding one column and filling the columns around it is both
   * cheaper than finding five and the thing the player actually asked for.
   * Neighbours are re-tested rather than assumed wet: a found column is often on
   * the edge of a lake, and half the ring around it is bank.
   *
   * @returns {number} bodies actually placed
   */
  _spawnShoal(nearCol, playerPos, budget) {
    if (budget <= 0) return 0;
    const seed = this._findWaterColumn(nearCol, playerPos);
    if (!seed) return 0;
    // The seed fish decides nothing for the rest — every body in the shoal asks
    // its own column, so a shoal that straddles a drop-off is reef fish on the
    // shelf and something else over the deep.
    let placed = this.spawn(this._pickFish(seed.col), seed.col, seed.k) ? 1 : 0;
    const want = Math.min(budget, SHOAL_MIN + Math.floor(Math.random() * SHOAL_SPAN));
    // Twice the attempts of the target count, so a shoal on a lake edge still
    // fills out rather than coming back as the one fish this was meant to end.
    for (let t = 0; t < want * 2 && placed < want; t++) {
      const di = Math.round((Math.random() * 2 - 1) * SHOAL_SPREAD);
      const dj = Math.round((Math.random() * 2 - 1) * SHOAL_SPREAD);
      const col = stepColumn(seed.col, di, dj);
      const k = this._waterLayer(col);
      if (k < 0) continue;
      if (this.spawn(this._pickFish(col), col, k)) placed++;
    }
    return placed;
  }

  /**
   * Is there anything a bee has a reason to be near?
   *
   * Nothing gated bee spawning before except the biome draw, and a bee hovering
   * over bare dirt is the same animal as a bee over a meadow as far as the
   * spawn code was concerned. Blooms, tall grass, saplings and any leaf will do
   * — five columns either way and a few layers up, because a bee flying at
   * `hover` above the ground is level with the canopy of nothing and the middle
   * of a flower bed.
   *
   * Twenty-five columns by four layers is a hundred lookups, run a handful of
   * times per spawn tick. Cheap enough to be a preference rather than a filter,
   * which matters — see _spawnDrift, which stops asking rather than give up.
   */
  _flowery(col, k) {
    const p = this.planet;
    for (let di = -2; di <= 2; di++) {
      for (let dj = -2; dj <= 2; dj++) {
        const c = stepColumn(col, di, dj);
        for (let dk = -1; dk <= 2; dk++) {
          const id = p.at(c, Math.max(0, k + dk));
          if (!id) continue;
          if (BLOOM.has(id) || IS_LEAF[id]) return true;
        }
      }
    }
    return false;
  }

  /**
   * Put a drift of bees over one patch of ground.
   *
   * The flowery test is a preference and not a requirement, and the last attempt
   * takes whatever it is given. A hard requirement would hand the desert and the
   * mountains — both of which list bees — a budget they could never spend, and a
   * budget that cannot be spent is exactly the bug this whole pass is about.
   *
   * @returns {number} bodies actually placed
   */
  _spawnDrift(nearCol, playerPos, budget) {
    if (budget <= 0) return 0;
    let seed = null;
    for (let t = 0; t < 3 && !seed; t++) {
      const spot = this._findSpawnColumn(nearCol, playerPos);
      if (!spot) break;
      if (t === 2 || this._flowery(spot.col, spot.k)) seed = spot;
    }
    if (!seed) return 0;
    let placed = 0;
    const want = Math.min(budget, DRIFT_MIN + Math.floor(Math.random() * DRIFT_SPAN));
    for (let t = 0; t < want * 2 && placed < want; t++) {
      const di = Math.round((Math.random() * 2 - 1) * DRIFT_SPREAD);
      const dj = Math.round((Math.random() * 2 - 1) * DRIFT_SPREAD);
      const col = t === 0 ? seed.col : stepColumn(seed.col, di, dj);
      const k = this.planet.surfaceK(col);
      if (k < 0 || k > D - 6) continue;
      // A flier does not need standing room, but it does need not to start
      // inside a block, and it must not start under water.
      if (this.planet.solidAt(col, k + 1) || this.planet.liquidAt(col, k + 1)) continue;
      // Drawn per column, exactly as _spawnShoal draws its fish per column, and
      // for the same reason: the seed decides where to look and nothing else.
      // One draw for the whole drift was made against the seed's biome and then
      // spent up to DRIFT_SPREAD columns away, which on any biome edge is a
      // different list — measured over twelve biomes, that put bees into the
      // savanna, the snow and the badlands, none of which lists one. A drift
      // that straddles a treeline is now forest bees on one side and nothing on
      // the other, which is what the tables say should happen.
      const type = this._pickFlier(col);
      if (!type) continue;
      if (this.spawn(type, col, k)) placed++;
    }
    return placed;
  }

  /** Is anything solid between (col, k) and the sky? */
  /**
   * Is this cell under a real roof — stone, planks, anything but foliage?
   *
   * Leaves used to count, and they are `solid` to the physics, so a forest floor
   * read exactly like a cave. Two rules then compounded: husks spawn in roofed
   * unlit pockets, and daylight only burns a husk the sky can see. Under a
   * canopy both were true at noon, so woodland was a permanent husk factory in
   * broad daylight and the sun could not clear it. Near one spawn, 2,483 of
   * 2,612 forest-floor columns qualified as cave.
   *
   * Foliage is dappled shade, not shelter. Anything the player builds still
   * counts, so a roofed hut is as dark as it looks.
   */
  _roofed(col, k) {
    for (let kk = k + 1; kk < D; kk++) {
      const id = this.planet.at(col, kk);
      if (!id || IS_LEAF[id]) continue;
      if (IS_SOLID[id]) return true;
    }
    return false;
  }

  /**
   * Seed the world around the player at world start.
   *
   * Two thirds of the wildlife budget, not all of it: the top-up tick fills the
   * rest in over the first minute, and it fills it in *around the player*, so
   * the opening moments do not stack the whole planet's animals in the first
   * clearing and leave the road out of it bare. That was half of what the
   * "concentrated near spawn" report was actually seeing.
   */
  populate(player, count = Math.round(MAX_WILDLIFE * 0.65)) {
    const c = player.cell;
    const startCol = cidx(c.f, Math.floor(c.ci), Math.floor(c.cj));
    // Where the world began, so the opening clearing stays where the player
    // woke up instead of travelling with them. A plain object rather than the
    // player's own Vector3: this is a fixed point on the planet and holding a
    // reference to something that moves every frame would make it the last
    // place the player stood.
    this.homePos = { x: player.position.x, y: player.position.y, z: player.position.z };
    for (let n = 0; n < count; n++) {
      const spot = this._findSpawnColumn(startCol, null);
      if (spot) this._spawnWild(spot.col, spot.k);
    }
    // Water and air get seeded too, and to the same two thirds. Left to the
    // top-up tick alone a new world starts with no fish and no bees at all and
    // takes the better part of a minute to grow any — and the first minute is
    // precisely when a player forms their opinion of whether the planet is
    // alive. `null` for the player position here for the same reason the land
    // pass passes it: at world start there is nothing to keep clear of yet.
    let wet = 0, air = 0;
    for (let n = 0; n < 6 && wet < MAX_AQUATIC * 0.65; n++) {
      const got = this._spawnShoal(startCol, null, MAX_AQUATIC - wet);
      if (!got) break;
      wet += got;
    }
    for (let n = 0; n < 6 && air < MAX_FLYING * 0.65; n++) {
      const got = this._spawnDrift(startCol, null, MAX_FLYING - air);
      if (!got) break;
      air += got;
    }
  }

  // --- simulation -----------------------------------------------------------

  _sync(mob) {
    const c = mob.cell;
    cellToWorld(c.f, c.ci, c.cj, c.ck, _p);
    mob.pos.set(_p[0], _p[1], _p[2]);
    tangentFrame(c.f, c.ci, c.cj, c.ck, mob.frame);
    mob.up.set(mob.frame.up[0], mob.frame.up[1], mob.frame.up[2]);
  }

  /**
   * The reference layer every terrain rule is measured from: the layer the
   * body's feet are being held up by.
   *
   * A layer INDEX, and that is the whole reason this exists as a function.
   * `_footprintCost` takes it as one, `_groundK` starts its scan at `hereK + 1`,
   * and both are integer-indexed into the block array — hand either of them a
   * height instead and every probe lands between two layers, reads undefined,
   * and comes back as "no ground here" for all nine samples. That is a body
   * that may not move in any direction, reported as a preference rather than as
   * an error. `_nudge` was doing exactly that (see the call there).
   *
   * For a walker it is the block under the feet. For a body floating at the
   * water line it is the water surface holding it up — see the long note at the
   * `here` in update(), which this is lifted from unchanged so that the two can
   * no longer drift apart.
   */
  _refLayer(mob) {
    const c = mob.cell;
    const p = this.planet;
    const feetK = Math.floor(c.ck);
    const col = this._colOf(c.f, c.ci, c.cj);
    const surfK = (mob.wading || (mob.swimming && !mob.spec.aquatic))
      ? this._waterTop(col, feetK) : -1;
    if (surfK >= 0 && c.ck > surfK - 1) return surfK;
    // A block whose top is inside its own layer — a slab, a stair tread — holds
    // the feet up from *within* the layer they are standing in, not from the
    // layer below. `floor(ck) - 1` is the layer under the feet and is right for
    // every full block on the planet; on a slab it names the block underneath
    // the slab, one lower than the thing actually carrying the animal.
    //
    // Everything downstream then reads one layer low. `_groundK` starts its
    // scan at `hereK + 1` and finds the slab, `gk > hereK` calls it a rise, and
    // all nine samples cost 1 — so a body standing on a slab floor scores 9
    // where it stands, in every direction. The consequences run both ways: a
    // shove is refused outright (see `_nudge`), and, worse, the equal-cost
    // escape rule in `_walkStep` then admits *every* move, because everything
    // ties at 9 — including walking into stone. Half-height blocks are the one
    // shape on which an animal could leave the world.
    if (c.ck - feetK > 0.02 && p.solidAt(col, feetK)
        && !isPassable(p.at(col, feetK), p.facingAt(col, feetK))
        && feetK + this._topOf(col, feetK) <= c.ck + 0.02) return feetK;
    return Math.floor(c.ck + 0.02) - 1;
  }

  /** Highest solid layer at or below `fromK` in `col`. */
  /**
   * Can the animal stand at (ci, cj) with its whole body, given it is currently
   * standing on layer `hereK`?
   *
   * Testing the centre column alone — which is what this used to do — stops the
   * animal's *centre* at the wall face and leaves the rest of it buried: a
   * woolly ended up 0.29 cells inside solid stone and stayed there. Sampling
   * the footprint's extremes keeps the body out of the wall.
   */
  _footprintCost(f, ci, cj, hereK, mob, hdg) {
    let cost = 0;
    // Nine samples over the animal's own oriented footprint: centre, the four
    // corners and the four edge midpoints. Sampling only the axis-aligned
    // extremes left the diagonals unguarded and the widest animal clipped
    // walls it met at an angle.
    const cw = Math.cos(hdg), sw = Math.sin(hdg);
    const hw = mob.halfW, hl = mob.halfL;
    // Is this body held up by water rather than standing on the bed? Three
    // different ways to be, and they want the same answer here: a fish, an
    // amphibian that has swum in, and a land animal that has ended up in the
    // river and is heading for the bank.
    const afloat = !!mob.spec.aquatic || !!mob.swimming || !!mob.wading;
    /** ...and the narrower question: is this body *only* ever in the water? */
    const aquaticBody = !!mob.spec.aquatic;
    /**
     * ...and the same question for the air. A flier is never grounded (see the
     * swimming/flying branch of the floor clamp), so this is a species reading
     * and not a state one, exactly like `aquatic`.
     */
    const flier = !!mob.spec.flies;
    // How deep a wet column may be and still be ground to this body — see
    // WADE_STAND. Read once for all nine samples, and only for the bodies the
    // water rule below actually applies to.
    const wade = (aquaticBody || mob.spec.flies || mob.spec.amphibious || afloat)
      ? 0 : this._wadeDepth(mob);
    for (let n = 0; n < 9; n++) {
      const lw = FOOT_OFF[n * 2] * hw;      // across the body
      const ll = FOOT_OFF[n * 2 + 1] * hl;  // along the body
      const oi = cw * ll - sw * lw;
      const oj = sw * ll + cw * lw;
      cost += this._colCost(this._colOf(f, ci + oi, cj + oj), hereK, mob,
        afloat, aquaticBody, flier, wade);
    }
    return cost;
  }

  /**
   * ...and the same question asked of the body's *middle* alone.
   *
   * One sample rather than nine, for the one caller that needs to tell a slide
   * along an obstacle from a walk into it — see the equal-cost clause in
   * _walkStep. It is the centre sample of _footprintCost and nothing else, so it
   * goes through the same per-column rule rather than a second copy of it.
   */
  _centreCost(f, ci, cj, hereK, mob) {
    const afloat = !!mob.spec.aquatic || !!mob.swimming || !!mob.wading;
    const aquaticBody = !!mob.spec.aquatic;
    const flier = !!mob.spec.flies;
    const wade = (aquaticBody || flier || mob.spec.amphibious || afloat)
      ? 0 : this._wadeDepth(mob);
    return this._colCost(this._colOf(f, ci, cj), hereK, mob,
      afloat, aquaticBody, flier, wade);
  }

  /**
   * What one column of a body's footprint costs it: 1 if the body may not be
   * there, 0 if it may.
   *
   * Lifted out of _footprintCost's loop unchanged when _centreCost was added,
   * so that the nine-sample test and the one-sample test can never come to
   * disagree about what an obstacle is. The flags are passed in rather than
   * re-read because the caller asks this of up to nine columns in a row and not
   * one of them varies between the samples.
   *
   * @returns {number} 1 or 0
   */
  _colCost(col, hereK, mob, afloat, aquaticBody, flier, wade) {
    const p = this.planet;
    const tall = mob.tall;
    {
      // A fish is asked a different question from everything else here, and it
      // has to be, because every test below this is measured from the *bed*.
      //
      // `_groundK` reports the highest solid at or below the animal's feet and
      // the water rule, the step rules and the headroom loop are all written
      // relative to it. For a walker that is exactly right — the bed is what it
      // is standing on. For a swimmer twenty layers above the seabed it is the
      // wrong height entirely: the headroom loop samples the water just above
      // the sand, and the only thing standing between a fish and a wall was
      // "is the block one above the bed wet". Measured, that permitted three
      // shapes it should have refused, and the middle one is every sloping
      // seabed on the planet:
      //
      //   - a one-layer shelf at the fish's own layer, water above and below;
      //   - a bed that steps up to exactly the fish's own layer (cost 0, so the
      //     fish swims into the sand and the floor clamp then lifts it out at
      //     MOB_MAX_RISE a frame — a fish climbing a staircase of seabed at
      //     sixty layers a second, drawn inside the rock the whole way);
      //   - a column that is *air* at the fish's layer, so long as it was wet
      //     down at the bed — i.e. an air pocket, or the dry side of a shore.
      //
      // So a swimmer gets the one test that is actually true of it: is there
      // rock where its body is, and is where its body is water. Only `aquatic`
      // takes this branch. A wading deer or a paddling crab keeps the bed-
      // relative rules below, which are what let it read a bank as a one-layer
      // step and climb out of the river; a fish never climbs out of anything.
      if (aquaticBody) {
        const kLo = hereK + 1, kHi = hereK + tall;
        if (this._aquaticCost(col, kLo, kHi)) return 1;
        // ...and it stays in the water. Lava is named rather than left to the
        // liquid test for the same reason it is named below.
        return (!p.liquidAt(col, kLo) || p.at(col, kLo) === ID.lava) ? 1 : 0;
      }
      // A flier is not walking either, and judging it by the walking rules is
      // what quietly took its horizontal collision away.
      //
      // Every test below this line is measured from the *bed* — `_groundK` off
      // the layer under the feet, then the step rules — and for a body holding
      // station in open air the bed is `hover` cells down. The drop rule
      // (`hereK - gk > MOB_STEP_DOWN`) therefore fires on every one of the nine
      // samples the moment a flier is more than MOB_FALL_FREE (3) layers up, so
      // `costHere` is 9, and _walkStep's equal-cost escape then admits *every*
      // heading — including straight into a cliff or a trunk. Measured on the
      // real planet before this branch existed: a parrot (hover 6.0) had
      // costHere > 0 on 93% of frames and spent 25.8% of them with its centre
      // inside solid rock, worst single stint 26.0s. The same fault scaled with
      // hover height across the other fliers: bat 34.8% inside, dragon 22.4%,
      // cthulhu 12.5%, ghost 2.5%, and the bee — hover 1.5, i.e. under the drop
      // rule's threshold — only 1.4%, which is what made it look like a parrot
      // bug rather than a flying bug.
      //
      // So a flier gets the one test that is true of it, which is the fish's:
      // is there rock where its body is. No water rule (a lake is not a wall to
      // something with wings — see the note below, and "birds should cross
      // water"), no step rules, no bed. Lava is kept, and kept as a span rather
      // than as a surface test, because the old `gk + 1` reading was the only
      // thing stopping a bee from hovering into a lava lake: FLY_LAVA_CLEAR
      // below the body covers the low hoverers and lets a parrot at six cross a
      // flow it is in no danger from.
      if (flier) {
        const kLo = hereK + 1, kHi = hereK + tall;
        if (this._aquaticCost(col, kLo, kHi)) return 1;
        for (let k = Math.max(0, kLo - FLY_LAVA_CLEAR); k <= kHi; k++) {
          if (p.at(col, k) === ID.lava) return 1;
        }
        return 0;
      }
      const gk = this._groundK(col, hereK + 1, !!mob.spec.climbs);
      if (gk < 0) return 1;
      // Nothing walks into lava, whatever else it is willing to walk into.
      //
      // Written out rather than left to the water rule below, which did cover
      // it by accident — lava is a liquid, and a land animal treats liquid as a
      // wall — but covered it only for the animals that were already refusing
      // water. A crab or a polar bear is `amphibious`, i.e. exempt from that
      // rule, so the two species on the planet that ignore water were also the
      // two that would happily paddle into a lava lake. "Animals should be
      // smart enough not to jump on cliffs or lava" is one rule, so it is one
      // test, applied to everything.
      if (p.at(col, gk + 1) === ID.lava) return 1;
      // Land animals treat water as a wall. _groundK only reports solid ground,
      // so a lake bed read as ordinary walkable terrain and a chicken would
      // stroll in and keep walking along the bottom. A fish has the opposite
      // rule: water is the only place it will go. An amphibian — the crab, the
      // polar bear — has no rule at all: both are fine, which is the whole
      // meaning of the flag. And a body already in the water is exempt for as
      // long as it is in there, or it could never swim a stroke.
      const wet = p.liquidAt(col, gk + 1);
      // A flier is not walking, so water is not a wall to it. Without this a
      // bee or a parrot treated a lake exactly as a land animal does and turned
      // back at the shore — which is why nothing ever flew over open water.
      // (Unreachable for a flier now, since the flier branch above returns
      // first, and deliberately left in place: it is the same rule stated where
      // the other bodies read it, and it is the thing to keep if that branch is
      // ever narrowed. "Birds should be willing to cross water" is held by both
      // of them saying the same thing.)
      //
      // ...and neither is a ford a wall. `!mob.wading` was the only way past
      // this line for a walker and it is unreachable from dry land, so nothing
      // that walks could ever choose to put a foot in water however shallow —
      // see WADE_STAND for what that cost the night. `_fordable` is the same
      // question asked of the depth instead of the flag, and it still says no
      // to lava, to anything out of its depth, and to every body too small to
      // stand in what is there.
      if (mob.spec.aquatic ? !wet
        : (wet && !mob.spec.flies && !mob.spec.amphibious && !mob.wading
           && !this._fordable(col, gk, wade))) {
        return 1;
      }
      // The step rules, which are about *walking* and so do not apply to
      // anything afloat. Applying them to a swimmer is what walls a paddling
      // animal into the middle of the lake: the bed is ten layers down, which
      // reads as too big a drop, and the bank is a layer up, which reads as too
      // big a rise, so every direction on the compass comes back refused. It is
      // also why a fish in deep ocean could not move horizontally at all —
      // measured, every heading cost 9 and the strict-improvement rule then
      // refused all of them. What is left for a swimmer is the one thing that
      // is still true of it: it cannot climb a cliff to get out.
      //
      // That rule was `gk > hereK + 1` — a step rule, in layer indices, off the
      // layer under the *feet* — and being written in the walker's units is
      // what broke it. A floating body's feet are not on anything: they hang
      // WADE_RIDE into the top water layer, so `hereK + 1` is the water surface
      // and `hereK + 1` as a ceiling meant the only ground a swimming animal
      // could ever move over was ground flush with the water line. A bank one
      // block proud of the water — the commonest shoreline on the planet — was
      // refused on every heading, while `_landBearing` cheerfully swam the
      // animal at it, because that search allows exactly that bank (`gk >
      // topK + 1` is its reject). Two rules written to the same intent in two
      // different units, and the animal in between them swam at a bank it was
      // never permitted to touch until the player walked away.
      //
      // So it is a reach now, in cells, off where the body actually is, and it
      // is the same number the floor clamp lifts by — see WADE_CLIMB. The two
      // cannot disagree, which is the whole point: a body is allowed over
      // ground exactly when it is allowed onto it.
      if (afloat) {
        if (gk + this._topOf(col, gk) > mob.cell.ck + this._haulReach(mob)) return 1;
        // Headroom still applies — see the loop at the end.
        for (let h = 1; h <= tall; h++) {
          const above = p.at(col, gk + h);
          if (IS_SOLID[above] && !isPassable(above, p.facingAt(col, gk + h))) return 1;
        }
        return 0;
      }
      //
      // Any rise at all blocks a walker. Letting a one-block step count as
      // walkable is what forced the height to be corrected after the fact —
      // instantly, or the body ended up inside the step. Making it an obstacle
      // means the only way up is the hop below, so the climb is always an arc.
      // The drop is MOB_STEP_DOWN rather than the 4 it was: an animal should
      // not walk off anything that would hurt it, and 4 was one more than the
      // fall it can take for free.
      if (gk > hereK || hereK - gk > MOB_STEP_DOWN) return 1;
      // Headroom. _groundK scans *downward* from just above the animal's feet,
      // so it reports the BOTTOM block of a wall and every wall — however tall
      // — came back as a harmless one-block step. That is what let animals
      // climb into solid stone. Standing somewhere means fitting there too.
      //
      // A ladder or an open door is `solid` but not an obstacle, and the player
      // already walks through both. Leaving them out here made a door pointless
      // — measured, the footprint cost of a doorway was 9 whether the door was
      // open or shut, so a hut with the door standing wide open was exactly as
      // safe as a sealed one and there was never a reason to close it.
      for (let h = 1; h <= tall; h++) {
        const above = p.at(col, gk + h);
        if (IS_SOLID[above] && !isPassable(above, p.facingAt(col, gk + h))) return 1;
      }
      return 0;
    }
  }

  /**
   * Is there rock in the layers a swimming body occupies in this column?
   *
   * The whole of a fish's collision, and deliberately the whole of it: no
   * ground, no step, no water. A body in open water is not standing on
   * anything, so "two things cannot be in the same place" is the only rule
   * left that means anything, and every other rule in _footprintCost is
   * measured from a bed that may be twenty layers down.
   *
   * Ladders and open doors are excluded exactly as they are everywhere else —
   * a flooded doorway is a way through for a fish too.
   *
   * @returns {number} 1 if the span is blocked, 0 if it is clear
   */
  _aquaticCost(col, kLo, kHi) {
    const p = this.planet;
    for (let k = kLo; k <= kHi; k++) {
      const b = p.at(col, k);
      if (IS_SOLID[b] && !isPassable(b, p.facingAt(col, k))) return 1;
    }
    return 0;
  }

  /**
   * The vertical half of a swimmer's collision, which did not exist.
   *
   * Horizontal movement goes through _walkStep and is tested; the rise and
   * fall is `c.ck += vel.k * dt` and was tested by nothing but the centre-
   * column ceiling probe below it, which asks about one column out of the nine
   * the body covers. A fish rising under the lip of an overhang, or through a
   * gap narrower than itself, went in side-first with its centre in clear
   * water and the probe none the wiser.
   *
   * Sampled over the same nine points the horizontal test uses, and refused
   * only when the destination is *worse* than where the body already is —
   * the same rule _walkStep runs on, and for the same reason: a fish that
   * arrived overlapping (a player built round it, a block was placed under it)
   * has to keep the move that gets it out.
   *
   * @returns {boolean} true if the body must not move to `nk`
   */
  _swimBlocked(mob, nk, ck) {
    const c = mob.cell;
    const cw = Math.cos(mob.heading), sw = Math.sin(mob.heading);
    const at = (h) => {
      const kLo = Math.floor(h + 0.02);
      const kHi = kLo + mob.tall - 1;
      let n = 0;
      for (let i = 0; i < 9; i++) {
        const lw = FOOT_OFF[i * 2] * mob.halfW;
        const ll = FOOT_OFF[i * 2 + 1] * mob.halfL;
        const col = this._colOf(c.f, c.ci + (cw * ll - sw * lw), c.cj + (sw * ll + cw * lw));
        n += this._aquaticCost(col, kLo, kHi);
      }
      return n;
    };
    // Same layer either side of the step: nothing can have changed, and this is
    // the overwhelming majority of frames.
    if (Math.floor(nk + 0.02) === Math.floor(ck + 0.02)) return false;
    return at(nk) > at(ck);
  }

  /**
   * Highest ground under the animal's whole footprint.
   *
   * Standing height came from the centre column alone, so an animal whose
   * leading edge had already crossed onto a step kept its old height until the
   * centre caught up — and for those frames its body was inside the riser.
   * That was the last of the sinking: every stray vertex measured was in the
   * same layer as the animal's feet, i.e. the face of the step ahead of it.
   */
  /**
   * Is the way forward a step the animal could stand on top of, and how big?
   *
   * One block ordinarily. `reach` is the escape licence — see _unstick — and it
   * is a parameter rather than a flag read off the mob so that the ordinary
   * walking call is visibly, statically, the rule it always was.
   *
   * @returns {number} layers to climb, or 0 for "nothing to step onto"
   */
  _stepAhead(mob, ci, cj, hereK, reach = 1) {
    const p = this.planet;
    const cw = Math.cos(mob.heading), sw = Math.sin(mob.heading);
    let best = 0;
    for (let n = 0; n < 9; n++) {
      const lw = FOOT_OFF[n * 2] * mob.halfW;
      const ll = FOOT_OFF[n * 2 + 1] * mob.halfL;
      const col = this._colOf(mob.cell.f, ci + (cw * ll - sw * lw), cj + (sw * ll + cw * lw));
      const gk = this._groundK(col, hereK + reach, !!mob.spec.climbs);
      const rise = gk - hereK;
      if (rise < 1 || rise > reach) continue;      // not a rise it could take
      // ...unless the block is taller than its own cell. A fence stands 1.5,
      // and without this an animal read the top of it as an ordinary step and
      // hopped the paddock wall it was meant to be kept behind.
      if (this._topOf(col, gk) > 1) continue;
      let clear = true;
      for (let h = 1; h <= mob.tall && clear; h++) if (p.solidAt(col, gk + h)) clear = false;
      if (!clear) continue;
      // The smallest step that gets it up there. Hopping the height of the
      // tallest thing under the footprint would clear a wall the body is only
      // brushing with one corner sample.
      if (!best || rise < best) best = rise;
    }
    return best;
  }

  /**
   * Height of the highest surface under the animal's footprint, as a real
   * height rather than a layer index.
   *
   * This used to return the layer and every caller added one for the top. Slabs
   * and stairs broke that: their tops are at k + 0.5, so an animal on a step
   * either hovered half a block above it or stood with its feet inside. Asking
   * the block where its top is costs one lookup and works for any shape.
   *
   * Only the centre sample counts unconditionally. The other eight count only
   * if the animal could actually *stand* on what they found — i.e. if there is
   * headroom for its whole height above that surface. That qualification is
   * this file's second attempt at animals arriving on treetops, and this time
   * the mechanism was measured rather than guessed at, so it is worth writing
   * down. The first fix (see the floor comment in update) assumed the only way
   * up was the scan starting too high, and started it from the animal's own
   * feet instead. The escalator that survived it works like this:
   *
   *   1. An animal's footprint is oriented, and it *rotated* freely — nothing
   *      gated turning on the terrain. A deer standing beside a trunk needed
   *      only to turn to face it for its half-length-ahead sample to land in
   *      the trunk's column. (Turning is checked against the terrain now, in
   *      the steering in update(), so that entry condition is shut as well.
   *      The qualification below is still what broke the escalator and is what
   *      to keep if the turn check is ever loosened: a body can be rotated by
   *      a shove or arrive already overlapping, and step 1 is the only one of
   *      the four that anything outside this file can cause.)
   *   2. That sample scans down from the deer's own feet layer and finds the
   *      trunk block *at* that layer. Its top is one cell up, so `best` — a
   *      max over the samples — comes back one higher than the ground the deer
   *      is standing on.
   *   3. The floor clamp's one-block cap is satisfied exactly: the rise is 1.0
   *      against MOB_MAX_RISE's 1.05. It lifts.
   *   4. Next frame the feet are a layer higher, so the scan starts a layer
   *      higher, and finds the *next* trunk block. Repeat at sixty frames a
   *      second.
   *
   * The cap was never the escalator's limit; it was its step size. What breaks
   * it is asking whether the thing found is somewhere a body fits — a trunk, a
   * cactus or a wall has itself stacked above it and fails, a genuine one-block
   * step or a stair tread has open air and passes. Which is the same question
   * _stepAhead already asks before it lets an animal hop, so the two now agree
   * on what "a step" means.
   *
   * @returns {number} surface height, or -1 if there is no ground below
   */
  _groundUnder(mob, f, ci, cj, fromK) {
    const p = this.planet;
    const cw = Math.cos(mob.heading), sw = Math.sin(mob.heading);
    let best = -1;
    for (let n = 0; n < 9; n++) {
      const lw = FOOT_OFF[n * 2] * mob.halfW;
      const ll = FOOT_OFF[n * 2 + 1] * mob.halfL;
      const col = this._colOf(f, ci + (cw * ll - sw * lw), cj + (sw * ll + cw * lw));
      const gk = this._groundK(col, fromK, !!mob.spec.climbs);
      if (gk < 0) continue;
      if (n > 0) {
        // Not the centre, so this is ground the body merely overhangs. It only
        // holds the animal up if the animal would fit standing on it.
        let fits = true;
        for (let h = 1; h <= mob.tall && fits; h++) {
          const above = p.at(col, gk + h);
          if (IS_SOLID[above] && !isPassable(above, p.facingAt(col, gk + h))) fits = false;
        }
        if (!fits) continue;
      }
      const surf = gk + this._topOf(col, gk);
      if (surf > best) best = surf;
    }
    return best;
  }

  /**
   * The surface height in one column, with none of the footprint spread.
   *
   * `_groundUnder` above is a max over nine samples because a walker really is
   * held up by whatever its feet reach. A swimmer is held up by nothing, and
   * that max is what lifted a shark out of the shallows and onto the bank — see
   * the swimmer's floor clamp in update().
   *
   * @returns {number} surface height, or -1 if there is no ground below `fromK`
   */
  _groundOwn(mob, col, fromK) {
    const gk = this._groundK(col, fromK, !!mob.spec.climbs);
    return gk < 0 ? -1 : gk + this._topOf(col, gk);
  }

  /**
   * The top of the tallest thing a flier is about to fly into, or -1.
   *
   * Two probes along the heading, in the same cell-space units the integrator
   * moves in — `fr.arcA`/`fr.arcB` convert cells-per-second into cell indices,
   * so a probe written in world cells stays the same distance ahead wherever on
   * the cube face the body is. See FLY_LOOK_NEAR.
   *
   * Only obstacles that actually intrude on the body's own layers count. A hill
   * a metre below it is not in its way, and treating it as one would have every
   * flier climbing forever over rolling ground.
   *
   * @returns {number} the surface height to clear, or -1 for open air
   */
  _flyAhead(mob, fr) {
    const p = this.planet;
    const c = mob.cell;
    const ch = Math.cos(mob.heading), sh = Math.sin(mob.heading);
    const kLo = Math.floor(c.ck + 0.02);
    const kHi = Math.floor(c.ck + mob.tall);
    let best = -1;
    // Across the body as well as ahead of it. Two probes on the centreline is
    // the right question for something one cell wide and the wrong one for a
    // cthulhu or a dragon, which are two to three cells across: a ridge caught
    // by a shoulder was never sampled, so they flew into it.
    //
    // Measured at *fixed* positions and headings - same body, same place, both
    // rules - because the obvious experiment does not work: letting them fly
    // and comparing runs puts the two dragons in different parts of the world
    // and the numbers then say nothing. Over 2,500 samples of real terrain:
    // cthulhu clips 19.88% of the time on the nose alone and 13.64% on three
    // lanes, dragon 22.68% against 15.92%, and a parrot 0.00% either way, since
    // its half width is under a cell and the extra lanes ask the same question.
    for (let n = 0; n < 6; n++) {
      // Off the *nose*, not off the origin. A dragon carries 1.9 of half-length,
      // so a probe measured from its centre lands inside its own body and it
      // learns about the mountain by hitting it: measured, the two big monsters
      // covered half the ground they used to until this term was added.
      const d = mob.halfL + (n < 3 ? FLY_LOOK_NEAR : FLY_LOOK_FAR);
      const off = ((n % 3) - 1) * mob.halfW;         // -1 left, 0 nose, 1 right
      const col = this._colOf(c.f,
        c.ci + (ch * d - sh * off) / fr.arcA,
        c.cj + (sh * d + ch * off) / fr.arcB);
      // Downward from the head, so the *top* of the obstacle is what comes back
      // — a wall reports its parapet, not the block the body happens to be
      // level with, and one climb clears it instead of sixty.
      for (let k = kHi; k >= kLo; k--) {
        const id = p.at(col, k);
        // Water is the floor, for anything that flies.
        //
        // This scan asked `IS_SOLID` and nothing else, and water is not solid,
        // so a flier looked straight THROUGH a lake to the seabed and read that
        // as the ground to hold height over - which is a bee flying calmly down
        // into the water. The surface is where the air stops, so it is what a
        // wing has to clear. Checked before the solid test because the seabed
        // below would otherwise win the loop.
        if (p.liquidAt(col, k)) {
          if (k + 1 > best) best = k + 1;
          break;
        }
        if (!IS_SOLID[id] || isPassable(id, p.facingAt(col, k))) continue;
        const surf = k + this._topOf(col, k);
        if (surf > best) best = surf;
        break;
      }
    }
    return best;
  }

  /**
   * Is the space this body would occupy solid rock?
   *
   * The only test a thrown body gets, and deliberately far weaker than
   * _footprintCost: no ground under it, no water rule, no step rules, no
   * strict-improvement bookkeeping. Every one of those encodes something the
   * animal *prefers*, and a body that has just been hit has stopped choosing.
   * What is left is the one thing that is true whether it likes it or not —
   * two things cannot be in the same place.
   */
  _bodyBlocked(f, ci, cj, ck, mob) {
    const p = this.planet;
    const cw = Math.cos(mob.heading), sw = Math.sin(mob.heading);
    // Rounded up, not down: a body standing on a slab or a stair tread has its
    // feet at k + 0.5, and flooring that would test the layer the tread itself
    // is in and report the animal as being inside solid rock — i.e. an animal
    // standing on a step could never be knocked anywhere at all.
    const k0 = Math.ceil(ck - 0.02);
    for (let n = 0; n < 9; n++) {
      const lw = FOOT_OFF[n * 2] * mob.halfW;
      const ll = FOOT_OFF[n * 2 + 1] * mob.halfL;
      const col = this._colOf(f, ci + (cw * ll - sw * lw), cj + (sw * ll + cw * lw));
      for (let h = 0; h < mob.tall; h++) {
        const id = p.at(col, k0 + h);
        if (IS_SOLID[id] && !isPassable(id, p.facingAt(col, k0 + h))) return true;
      }
    }
    return false;
  }

  /**
   * Move a body that is being thrown rather than walking.
   *
   * Substepped, unlike the walking move, and it has to be. The walking move
   * gets away with one step a frame because nothing on the planet ambles
   * faster than the bee's 6.3 cells/s — see the note there — and a struck
   * bunny leaves at 14.4. At the 0.1s frame main.js allows, that is a cell and
   * a half in one go, which is a body arriving on the far side of a wall
   * without ever having been inside it. Half a cell a substep keeps the sweep
   * finer than the thinnest thing it could pass through.
   *
   * A blocked axis has its knock cancelled rather than merely refused: a shove
   * that keeps grinding into the wall it already hit is what pins a struck
   * animal against the stone for the rest of KNOCK_TIME.
   */
  _tumble(mob, di, dj) {
    const c = mob.cell;
    const steps = Math.max(1, Math.ceil(Math.hypot(di, dj) / 0.35));
    const si = di / steps, sj = dj / steps;
    for (let n = 0; n < steps; n++) {
      if (!this._bodyBlocked(c.f, c.ci + si, c.cj, c.ck, mob)) c.ci += si;
      else mob.knockA = 0;
      if (!this._bodyBlocked(c.f, c.ci, c.cj + sj, c.ck, mob)) c.cj += sj;
      else mob.knockB = 0;
    }
  }

  /**
   * The ordinary horizontal move: one step of walking, with everything the
   * animal is entitled to refuse.
   *
   * Lifted out of update() when the tumble was added, unchanged. The two moves
   * disagree about nearly everything, and the difference between them is the
   * point — see the fork at the call site.
   *
   * The axes resolve separately so a blocked animal slides along the wall
   * instead of stopping dead and pirouetting in place.
   *
   * A move is allowed only if the destination is fully clear, or if it
   * *strictly* reduces the overlap the body is already in. Both halves are
   * load-bearing. An animal that spawned in a tree, or was walled in by a
   * player, already fails the footprint test where it stands, and gating on the
   * destination alone froze it there forever — 13 of 16 of a wild herd, as it
   * turned out. But merely "no worse" was not enough either: an animal touching
   * a wall could swap one blocked sample for another and slide onward into the
   * stone at no cost, which is what kept bodies sunk into blocks.
   */
  _walkStep(mob, ni, nj, here, fr, player) {
    const c = mob.cell;
    const costHere = this._footprintCost(c.f, c.ci, c.cj, here, mob, mob.heading);
    /**
     * May the body take a move that costs this much?
     *
     * A legal spot costs nothing and may only move to another legal spot: that
     * is the rule, it is unchanged, and it is what stops an animal walking into
     * a wall or off a cliff.
     *
     * The second half is for a body that is *already* overlapping something,
     * and it used to demand a strict improvement. That reads as safe and is the
     * other half of the shoreline report — the half where the animal never even
     * reached the water. Cost is a count of nine samples, so it moves in whole
     * numbers, while a step is a fiftieth of a cell: a deer shoved a third of a
     * cell toward a river ends up with one hind sample in the water, cost 1, and
     * every direction it can try — including straight inland — is also cost 1
     * until that one sample crosses a column boundary a third of a cell away. It
     * cannot get there in steps that must each strictly improve, so it never
     * moves again. Measured: frozen for the whole run, cycling walk / idle /
     * graze with its feet nailed down, which is exactly "after hitting it, it
     * can't run away".
     *
     * Equal is therefore allowed, but only *out* of a spot that is already bad.
     * The creep this guards against cannot happen through it: going deeper into
     * water or rock puts another sample in and costs more, so the moves it
     * newly admits are the ones that slide *along* an obstacle, which is the
     * behaviour the wall slide exists to produce and which the shore had been
     * denying.
     */
    /**
     * ...and the one thing the equal-cost clause may not do, which is bury the
     * body's own middle.
     *
     * The clause above is right about slides and wrong about the direction of
     * travel, because a count of nine samples cannot tell "along the obstacle"
     * from "further into it": a body with one hind sample in the river can swap
     * that sample for a different one and pay the same 1, over and over, and
     * each swap moves it a step further in. That is how a cow ends up walking on
     * a lake bed — measured before this test, 3.11% of cow-frames fully under
     * water with the body grounded, worst single stint 28.0 seconds, which is
     * the reported "cow walking underwater" exactly.
     *
     * The centre sample is the honest test of which of the two is happening.
     * Sliding along a wall keeps a corner in the stone and the middle in the
     * open; walking into it does not. So an equal-cost move may not newly put
     * the centre column into something the body cannot be in — and a body whose
     * centre is *already* buried keeps every equal move it had, because that is
     * the case the clause exists for.
     *
     * One column of samples rather than nine, and only asked on the frames the
     * equal-cost branch is actually reached, which is a body already overlapping
     * something. An ordinary animal on open ground never pays for it.
     */
    const centreHere = costHere > 0 && this._centreCost(c.f, c.ci, c.cj, here, mob);
    const ok = (cost, ci, cj) => cost === 0 || cost < costHere
      || (costHere > 0 && cost === costHere
        && (centreHere || !this._centreCost(c.f, ci, cj, here, mob)));
    const costI = this._footprintCost(c.f, ni, c.cj, here, mob, mob.heading);
    const costJ = this._footprintCost(c.f, c.ci, nj, here, mob, mob.heading);
    let okI = ok(costI, ni, c.cj);
    let okJ = ok(costJ, c.ci, nj);
    // The corner. Resolving the axes separately is what lets a body slide along
    // a wall instead of stopping dead, and the cost of it is that the diagonal
    // the two moves add up to is never tested: at an inside corner each axis
    // alone is clear water and the cell they meet in is stone, so the body cuts
    // straight through the corner block.
    //
    // Only a swimmer takes this test. On the ground the diagonal is covered by
    // something a fish does not have — a walker's destination has to be ground
    // it can stand on, and the corner block's *top* is what it would be
    // standing on, so the step rules catch it. The land move is also the one
    // that has been tuned against half the animals on the planet, and the
    // elephant that has just been widened leans on the wall slide to get itself
    // out of dense forest; narrowing what it may do is not part of this fix.
    // ...and a flier is in the same position as a swimmer, for the same reason:
    // it has no step rules to catch the corner block's top, because it is not
    // standing on anything. Without this a bee rounds an inside corner through
    // the stone.
    if (okI && okJ && (mob.spec.aquatic || mob.spec.flies)
      && !ok(this._footprintCost(c.f, ni, nj, here, mob, mob.heading), ni, nj)) {
      // Keep the axis that is cheaper on its own, so the body still slides
      // along the corner rather than stopping in front of it.
      if (costI <= costJ) okJ = false; else okI = false;
    }
    if (okI) c.ci = ni;
    if (okJ) c.cj = nj;
    // Hop when the way *forward* is barred, not only when both axes are.
    // Gating on "moved nowhere" meant an animal still sliding along the wall
    // on its other axis never jumped — it just shuffled sideways forever
    // against the step it was trying to climb.
    const moved = okI || okJ;
    const blockedAhead = !okI || !okJ;
    // Remembered for the turn check in update(). A body that cannot translate
    // at all has to be allowed to rotate however it likes, because rotating is
    // the only move it has left and every way out of here — the veer below, the
    // wall slide, the doorway probe — works by changing the heading. Set before
    // the early return on purpose: an animal that is boxed in while standing
    // still is the case that most needs the exemption.
    mob.stuck = !moved;
    if (!blockedAhead || mob.speedNow <= 0.02) return;
    // How tall a step it may take. One block ordinarily; taller while the
    // escape licence is live *and* the body could not translate at all this
    // frame, which is the difference between a hole and a wall it is merely
    // walking alongside. See ESCAPE_RISE and _unstick.
    const climb = (mob.escapeT > 0 && !moved) ? 1 + ESCAPE_RISE : 1;
    const rise = mob.grounded ? this._stepAhead(mob, ni, nj, here, climb) : 0;
    if (rise > 0) {
      // A step it could stand on: push off and let gravity do the rest. The
      // move stays refused until the animal is genuinely above the step, at
      // which point the footprint clears on its own and it walks on in mid-air.
      // Real arc, and the body is never inside the block.
      mob.vel.k = Math.sqrt(2 * GRAVITY * (rise + 0.30));
      mob.grounded = false;
    } else if (!moved) {
      // veer, don't spin: nudge the desired heading and let the turn-rate
      // limiter rotate the model there over several frames
      //
      // A hunter veers a fixed way and keeps its speed, so it slides along
      // whatever it walked into instead of milling in front of it. Facing
      // straight at a wall leaves no lateral velocity to slide with — a husk
      // pressed against a hut simply stopped there, which meant it could never
      // find the doorway and an open door was as safe as a shut one. It commits
      // to a side for a while rather than re-rolling every frame, because a
      // direction chosen afresh sixty times a second averages out to standing
      // still.
      if (mob.target === 'player') {
        // Before committing to a side, look for a way through. Sliding finds a
        // gap only by luck; probing a fan of headings finds the doorway on the
        // frame it comes into view, which is the difference between a door that
        // matters and one that does not.
        //
        // The probe deliberately still aims at the *player*, not at the route's
        // next waypoint, even while a route is being followed. Aiming it at the
        // waypoint sounds obviously right — local avoidance serving the route
        // rather than arguing with it — and measured worse across the board:
        // the long-wall case went from reaching the player in 5.5s to never
        // reaching them at all. When a body is pressed against a wall its next
        // waypoint is usually straight through that wall, so every whisker
        // reads as blocked, the probe returns null, and the mob falls through
        // to a wall-slide in a random direction that no longer has anything to
        // do with where the player is. Aiming at the player keeps the slide
        // biased toward the goal, which is what actually finds gaps.
        const probed = this._probeAround(mob, c, here, fr, player);
        if (probed !== null) {
          mob.want = probed;
          mob.slideT = 0;              // a way through beats going round
        } else {
          if (mob.slideT <= 0) {
            mob.slideT = WALL_SLIDE_TIME;
            mob.slideDir = Math.random() < 0.5 ? -1 : 1;
          }
          mob.want = wrapAngle(mob.want + mob.slideDir * WALL_SLIDE_TURN);
        }
        mob.speedNow *= 0.9;
      } else {
        mob.want = wrapAngle(mob.heading
          + (Math.random() < 0.5 ? -1 : 1) * (1.1 + Math.random() * 0.9));
        mob.speedNow *= 0.35;
        // ...and hold it, against whatever keeps re-aiming this body at the
        // obstacle. A wandering animal has nothing to argue with — its heading
        // is only chosen when the state runs out — but a *bolting* one is aimed
        // directly away from what frightened it on every single frame, so the
        // deflection chosen here was overwritten before it could be walked, and
        // a deer with a river behind it ran on the spot at the water's edge for
        // as long as the predator stood there. The same clock the hunter's wall
        // slide uses, and for the same reason: a direction re-rolled sixty times
        // a second averages out to standing still. See _boltAway.
        mob.slideT = WALL_SLIDE_TIME;
      }
    }
  }

  /**
   * Which way the nearest bank is, for a land animal that has ended up in the
   * water.
   *
   * The mirror of _shoreBearing and deliberately not a flag on it: a crab
   * wants the water *line* and stops once it is near one, a swimming deer
   * wants dry ground and is not finished until it is standing on some. Rings
   * outward a column at a time rather than in SHORE_STEPs, because the nearest
   * bank is the whole answer here and stepping two at a time can walk straight
   * over the one-column spit that was the way out.
   *
   * A bank it could not climb out onto does not count. Swimming at the foot of
   * a cliff forever is the failure this avoids, and it is a real one — a river
   * cut into rock has two of them, one on each side.
   *
   * 8 x SWIM_LOOK column probes, at most once every SWIM_PERIOD per animal
   * that is actually in the water, and the ground scan is bounded to a couple
   * of layers around the surface rather than the whole shell.
   */
  _landBearing(mob, col) {
    const p = this.planet;
    const topK = this._waterTop(col, Math.floor(mob.cell.ck));
    // Eight rays rather than eight rings, and the difference is a `blocked`
    // flag per direction.
    //
    // Rings looked *through* walls. A cliff was `continue` — keep looking — so
    // the search went on past it and cheerfully returned the bearing to the
    // open plain on the far side of a rim it had already refused. That is the
    // ringed-lake report exactly, and it is worse than no answer: the animal
    // holds a heading at ground it can see and can never reach, and presses
    // itself into the intervening wall for as long as anyone is watching.
    // Measured on a lake with a three-column rim standing two blocks proud: the
    // deer reached the rim at 4.0s and had not moved a hundredth of a cell by
    // 30s, at a full paddle the whole time.
    //
    // A cliff now ENDS that direction. Everything beyond it is somewhere this
    // body cannot walk to from here, whatever it looks like, and a search that
    // reports unreachable ground is not a search that has found anything.
    let live = 0xff;
    for (let s = 1; s <= SWIM_LOOK && live; s++) {
      for (let n = 0; n < 8; n++) {
        const bit = 1 << n;
        if (!(live & bit)) continue;
        const di = RING8[n * 2] * s, dj = RING8[n * 2 + 1] * s;
        const c2 = stepColumn(col, di, dj);
        const gk = this._groundK(c2, topK + 2, !!mob.spec.climbs);
        if (gk < 0) continue;
        if (gk > topK + 1) { live &= ~bit; continue; }  // a cliff face, not a bank
        if (p.liquidAt(c2, gk + 1)) continue;           // still water — keep looking
        return Math.atan2(dj, di);
      }
    }
    return null;
  }

  /**
   * Which way is *along* the bank, for a swimmer that has been told there is no
   * way out of this water.
   *
   * The companion to `_landBearing` and deliberately a separate search rather
   * than a flag on it, on the same grounds that `_shoreBearing` is separate:
   * they are asking different questions. `_landBearing` wants a bank it may
   * climb and refuses everything else. This wants the nearest bank of ANY
   * height — a cliff is still a shore — and returns the bearing turned a right
   * angle, so the body travels along the water's edge instead of into it.
   *
   * Which of the two right angles is held on `slideDir`, the same field the
   * wall slide commits to a side with, and for the same reason: a side redrawn
   * every time this is asked would average out to swimming on the spot, which
   * is the behaviour being replaced.
   *
   * Following the shore is also what *finds* a way out on any lake bigger than
   * the search: a low stretch a long way round the rim is out of
   * `_landBearing`'s SWIM_LOOK columns from here, and is inside it from a
   * quarter of the way round. So this is not only the thing that stops the
   * thrashing, it is the only route out of a large lake that has one.
   *
   * @returns {number|null} a heading, or null if there is no bank in reach at
   *   all — the middle of an ocean, where there is nothing to follow.
   */
  _shoreTangent(mob, col) {
    const p = this.planet;
    const topK = this._waterTop(col, Math.floor(mob.cell.ck));
    for (let s = 1; s <= SWIM_LOOK; s++) {
      // Every bank at this range, summed, and not the first one found. In a
      // corner two walls are the same distance away, and taking either one of
      // them alone gives a tangent that runs straight into the other — measured,
      // a deer followed the east bank of a walled lake for fourteen seconds and
      // then parked in the north-east corner for the rest of the run. Summing
      // gives the direction the water's edge actually faces, so a corner reads
      // as diagonal and the tangent rounds it.
      let ai = 0, aj = 0;
      for (let n = 0; n < 8; n++) {
        const di = RING8[n * 2], dj = RING8[n * 2 + 1];
        const c2 = stepColumn(col, di * s, dj * s);
        // Ground standing over the water line, whether or not it can be climbed
        // onto. Above `topK` is the bank; anything at or under the water line is
        // more water, or the bed, and neither is a shore.
        const gk = this._groundK(c2, topK + 3, !!mob.spec.climbs);
        if (gk < 0 || gk <= topK) continue;
        if (p.liquidAt(c2, gk + 1)) continue;
        const inv = (di && dj) ? Math.SQRT1_2 : 1;    // diagonals are longer
        ai += di * inv; aj += dj * inv;
      }
      if (ai === 0 && aj === 0) continue;
      const side = mob.slideDir || 1;
      return wrapAngle(Math.atan2(aj, ai) + side * (Math.PI / 2));
    }
    return null;
  }

  /**
   * The progress watchdog: has this body actually been getting anywhere, and
   * what to do about it if not.
   *
   * Every other rule in this file is about the current frame. This is the only
   * one with a memory, and that is the whole point — a body pressed into a bank
   * is refused by rules that are each individually correct, and no single-frame
   * test can tell that state apart from a body that has simply stopped to
   * graze. Half a minute of it can.
   *
   * Three stages, in increasing order of how much they are allowed to bend:
   *
   *   1. Steer at ground that is definitely walkable. Most of the census's
   *      findings are a body that could walk somewhere useful and was aimed at
   *      something else — a bank it may not climb, a wall it keeps sliding
   *      along, the middle of a hollow.
   *   2. Loosen the step rule while it does, so a two-block pit stops being a
   *      permanent home. See ESCAPE_RISE for why this cannot open paddocks.
   *   3. Only after three of those have run out with the body still in the same
   *      place — about half a minute of it — move the body, and never in sight
   *      of the player. Teleporting an animal is a bad thing to see and a worse
   *      thing to leave broken.
   *
   * Cost: one distanceTo per body per second, plus a bounded column search per
   * body that is actually stuck. Nothing here runs on the ordinary frame of an
   * ordinary animal.
   *
   * @returns {number|null} a heading to hold this frame, or null
   */
  _unstick(mob, dt, dist, fr) {
    if (mob.spec.phantom || mob.dying > 0 || mob.tumbling) return null;
    mob.progT += dt;
    if (mob.progT >= STALL_PERIOD) {
      mob.progT = 0;
      // Only the seconds it *wanted* to move count against it, and a second it
      // spent grazing counts for nothing either way. Resetting on an idle
      // second would mean a body that alternates walk and graze — which is what
      // a stuck animal does, it still runs its state machine — could never
      // accumulate enough of them.
      //
      // ...and a body that has arrived at something is not stuck either. A
      // hunter standing over its kill, a hostile swinging at the player and a
      // courting pair circling each other are all in a movement state, at
      // speed, going nowhere, and all three are behaving exactly as intended.
      const busy = (mob.love > 0)
        || (mob.target === 'player' && dist < 4)
        || (mob.prey && !mob.prey.released && mob.pos.distanceTo(mob.prey.pos) < 4);
      const trying = !busy && mob.speedNow > 0.25
        && (mob.state === 'walk' || mob.state === 'flee' || mob.state === 'chase');
      if (mob.pos.distanceTo(mob.progAt) >= STALL_RANGE) {
        mob.progAt.copy(mob.pos);
        mob.progN = 0;
        mob.escapeFails = 0;
      } else if (trying) mob.progN++;
      if (mob.progN >= STALL_TRIES && mob.escapeT <= 0) {
        // The search is bounded per call, but a hundred bodies deciding they
        // are stuck on the same frame is a frame spike rather than a hundred
        // small costs. A couple a frame drains any plausible backlog inside a
        // second, and the clock the body is waiting on is measured in seconds.
        if (this._escapeBudget <= 0) return null;
        this._escapeBudget--;
        mob.progN = 0;
        mob.escapeCol = this._escapeGoal(mob);
        mob.escapeT = ESCAPE_TIME;
        mob.escapeFails++;
        // The last resort. `_inView` reads the camera and is false when there
        // is none, which is right for a headless run and is *not* the whole
        // gate: a body behind the player is out of frame and still only a few
        // steps away, so the distance test stands beside it.
        if (mob.escapeFails > RELOCATE_AFTER && mob.escapeCol >= 0
            && dist > RELOCATE_MIN_DIST && !this._inView(mob, 1.15)) {
          this._relocate(mob, mob.escapeCol);
          mob.escapeT = 0;
          mob.escapeCol = -1;
          mob.escapeFails = 0;
          return null;
        }
      }
    }
    if (mob.escapeT <= 0) return null;
    mob.escapeT -= dt;
    if (mob.escapeCol < 0) return null;
    const c = mob.cell;
    if (this._colOf(c.f, c.ci, c.cj) === mob.escapeCol) {
      // Arrived. Nothing more to prove.
      mob.escapeT = 0;
      mob.escapeCol = -1;
      mob.escapeFails = 0;
      return null;
    }
    const g = colParts(mob.escapeCol, _pp);
    cellToWorld(g.f, g.i + 0.5, g.j + 0.5, c.ck, _p);
    _rel.set(_p[0] - mob.pos.x, _p[1] - mob.pos.y, _p[2] - mob.pos.z);
    const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
    const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
    if (Math.abs(ra) < 1e-5 && Math.abs(rb) < 1e-5) return null;
    return Math.atan2(rb, ra);
  }

  /**
   * The nearest column this body could stand on and walk away from.
   *
   * A breadth-first walk over the column graph — `colNeighbor`, so it crosses a
   * cube seam without arithmetic — with the step rules loosened by ESCAPE_RISE
   * and, deliberately, no water rule at all. A deer that has to cross a lake to
   * reach the bank has to be allowed to plan across the lake, and a fish thrown
   * onto the sand has to be allowed to flop back over it. What the body may
   * *do* is still decided by the ordinary movement code; this only decides
   * which way to point it.
   *
   * @returns {number} a column, or -1 if there is nothing better in reach
   */
  _escapeGoal(mob) {
    const p = this.planet;
    const climbs = !!mob.spec.climbs;
    const start = this._colOf(mob.cell.f, mob.cell.ci, mob.cell.cj);
    const from0 = Math.max(0, this._refLayer(mob));
    /** The layer this body would end up on in `col`, or -1. */
    const reach = (col, from) => {
      const gk = this._groundK(col, from + ESCAPE_RISE + 1, climbs);
      if (gk < 0) return -1;
      if (gk - from > ESCAPE_RISE + 1) return -1;
      if (from - gk > MOB_STEP_DOWN + ESCAPE_RISE) return -1;
      if (p.at(col, gk + 1) === ID.lava) return -1;
      for (let h = 1; h <= mob.tall; h++) {
        const above = p.at(col, gk + h);
        if (IS_SOLID[above] && !isPassable(above, p.facingAt(col, gk + h))) return -1;
      }
      return gk;
    };
    const seen = new Map([[start, from0]]);
    let frontier = [start];
    let fallback = -1;
    for (let ring = 0; ring < ESCAPE_LOOK && frontier.length && seen.size < ESCAPE_BUDGET; ring++) {
      const next = [];
      for (let n = 0; n < frontier.length; n++) {
        const cur = frontier[n];
        const from = seen.get(cur);
        for (let d = 0; d < 4; d++) {
          const nb = colNeighbor(cur, d);
          if (nb < 0 || seen.has(nb)) continue;
          const gk = reach(nb, from);
          if (gk < 0) continue;
          seen.set(nb, gk);
          next.push(nb);
          const q = this._goodGround(nb, gk, mob);
          if (q === 2) return nb;
          if (q === 1 && fallback < 0) fallback = nb;
        }
      }
      frontier = next;
    }
    return fallback;
  }

  /**
   * Is this somewhere the body could live, rather than merely stand?
   *
   * Two grades, because the best answer is often not in reach: 2 is ground with
   * room to walk away in three directions, 1 is somewhere it could at least be.
   * A swimmer's answer is the mirror image — water with water above it — since
   * "walkable" for a fish means wet.
   *
   * @returns {number} 2, 1 or 0
   */
  _goodGround(col, gk, mob) {
    const p = this.planet;
    const wet = p.liquidAt(col, gk + 1);
    if (mob.spec.aquatic) {
      if (!wet || p.at(col, gk + 1) === ID.lava) return 0;
      return p.liquidAt(col, gk + 1 + mob.tall) ? 2 : 1;
    }
    // Standing water counts only if the body could ford it; otherwise this is
    // the lake it is trying to leave.
    if (wet && !mob.spec.amphibious && !mob.spec.flies
        && !this._fordable(col, gk, this._wadeDepth(mob))) return 0;
    let open = 0;
    for (let d = 0; d < 4; d++) {
      const nb = colNeighbor(col, d);
      if (nb >= 0 && this._stepTo(nb, gk, mob) >= 0) open++;
    }
    return open >= 3 ? 2 : open >= 2 ? 1 : 0;
  }

  /**
   * Put a body somewhere it can walk. The last resort, and gated on nobody
   * looking — see _unstick.
   */
  _relocate(mob, col) {
    const gk = this._groundK(col, D - 1, !!mob.spec.climbs);
    if (gk < 0) return;
    const { f, i, j } = colParts(col);
    const c = mob.cell;
    c.f = f; c.ci = i + 0.5; c.cj = j + 0.5;
    c.ck = gk + this._topOf(col, gk) + 0.02 + (mob.spec.aquatic ? mob.belly : 0);
    mob.vel.i = 0; mob.vel.j = 0; mob.vel.k = 0;
    // Not a fall, not a shove, and not still holding a tree it is no longer
    // beside: everything the old spot had done to this body is over.
    mob.fallFrom = null;
    mob.knockT = 0;
    mob.tumbling = false;
    mob.climbTo = null;
    mob.progN = 0;
    this._sync(mob);
    mob.progAt.copy(mob.pos);
  }

  /**
   * How far above itself a floating body may haul out, in cells.
   *
   * One expression, read by the footprint test and by the floor clamp, so a
   * body is allowed *over* exactly the ground it is allowed *onto*. See
   * WADE_CLIMB and WADE_ESCAPE.
   */
  _haulReach(mob) {
    return WADE_CLIMB + (mob.escapeT > 0 ? WADE_ESCAPE : 0);
  }

  /** How far above its own floor the block at (col, k) reaches, 0..1. */
  _topOf(col, k) {
    const id = this.planet.at(col, k);
    if (!IS_SHAPED[id]) return 1;
    const boxes = collisionBoxes(id, this.planet.facingAt(col, k));
    let top = 0;
    for (let b = 0; b < boxes.length; b++) if (boxes[b][5] > top) top = boxes[b][5];
    return top;
  }

  /**
   * Highest solid layer at or below `fromK`, ignoring things you can walk
   * through. An open door and a ladder are `solid` but are not floors — counted
   * as ground they read as a one-block step up in the middle of a doorway, and
   * the footprint test refuses the move for a *different* reason than the
   * headroom check does. Both have to agree or the door still cannot be walked
   * through.
   */
  /**
   * Is there a trunk or a branch within reach of this cell to hold on to?
   *
   * A climber goes up the air column *beside* the tree rather than inside it,
   * for the plain reason that a trunk is solid and a monkey drawn inside one
   * looks like a bug. Holding on to the neighbour is also what makes the climb
   * end by itself: step away from the tree and there is nothing to hold.
   */
  _climbHold(col, k) {
    // Feet *and* the layer above them. Checking only the feet found nothing at
    // the bottom of a trunk: an animal stands on the ground layer and the tree
    // beside it starts at the next one up, so a monkey with both hands on a
    // trunk measured as holding nothing at all.
    for (let h = 0; h <= 1; h++) {
      const kk = k + h;
      if (kk < 0 || kk >= D) continue;
      for (let d = 0; d < 4; d++) {
        const n = colNeighbor(col, d);
        if (n < 0) continue;
        if (IS_TREE[this.planet.at(n, kk)]) return true;
      }
    }
    return false;
  }

  /**
   * The canopy a climber standing here could get to, or -1.
   *
   * Measured from a real oak: the trunk is seven layers of wall and the lowest
   * leaf sits level with its top, so there is no staircase up a tree and no
   * amount of relaxing the step rules would find one. The climb has to be a
   * climb.
   */
  _canopyAbove(col, fromK) {
    const p = this.planet;
    for (let k = Math.floor(fromK) + 1; k < Math.min(D - 1, fromK + CLIMB_REACH); k++) {
      if (IS_LEAF[p.at(col, k)]) {
        // The last clear layer *under* the foliage — in the branches, not on the
        // roof. Aiming at the top of the canopy does not work and should not:
        // leaves are solid, so a body cannot pass up through them, and a monkey
        // sent there climbed until its head met the first leaf and then hung at
        // that height for good — never arriving, so never starting the timer
        // that brings it back down. Sitting in the branches is both reachable
        // and the thing an actual monkey does.
        return k - 1;
      }
    }
    return -1;
  }

  /**
   * @param {boolean} [climber] whether foliage counts as floor for this body.
   *   Off for everything but a monkey — see the leaf rule below.
   */
  _groundK(col, fromK, climber = false) {
    const p = this.planet;
    for (let k = Math.min(D - 1, fromK); k >= 0; k--) {
      if (!p.solidAt(col, k)) continue;
      if (isPassable(p.at(col, k), p.facingAt(col, k))) continue;
      // Foliage is not a floor. Leaves are `solid` — you can stand on a canopy,
      // and the player is welcome to — but for anything deciding where to
      // *walk*, a canopy is a surface reachable by a one-block hop from the
      // branch beside it, and husks were quietly climbing trees and spending
      // the night standing on top of them.
      //
      // A climber is the deliberate exception, and it is per-species rather
      // than a relaxation of the rule: `climbs` is on the monkey and nothing
      // else, so the husks stay on the ground where that comment put them.
      if (!climber && IS_LEAF[p.at(col, k)]) continue;
      return k;
    }
    return -1;
  }

  /**
   * Should this animal be heard right now? Near animals always are; far ones
   * only when they are roughly in front of the player, so a flock chattering
   * behind a hill stays quiet. The global cooldown is the herd limiter.
   */
  _tryVocalise(mob, dist, player) {
    if (!this.onSound) return;
    // Silence, and deliberately. There is no sample for him — Audio.mob keys on
    // the species name — and the brief is explicit that no asset is to be added
    // for this. A sighting that announces itself is a jump scare; the whole
    // effect here is that nothing happens at all.
    if (mob.spec.phantom) return;

    // The merchant is meant to be found by ear, and every rule below was
    // written for herd noise: a shared one-call-per-second budget it has to win
    // against sixteen animals, silence past 42 units, and past 14 a test that
    // you already be looking at it. Together those make the bell audible almost
    // only when you had already found him. He rings on his own clock, at his
    // own range, and never competes with the paddock.
    if (mob.spec.trader) {
      if (dist > BELL_RANGE) return;
      if (this.bellT > 0) return;
      this.bellT = BELL_MIN + Math.random() * (BELL_MAX - BELL_MIN);
      this.voxCount++;
      this.onSound('idle', mob);
      return;
    }

    if (dist > VOX_RANGE) return;
    if (this.voxCooldown > 0) { this.voxSuppressed++; return; }
    if (dist > VOX_NEAR) {
      const look = player.lookDir;
      if (!look) return;
      _vox.copy(mob.pos).sub(player.eye || player.position);
      if (_vox.lengthSq() < 1e-6) return;
      if (_vox.normalize().dot(look) < VOX_FACING) return;
    }
    // One call per ~0.8-1.8s across the whole world, whatever the herd size —
    // and it is the *whatever* that matters, because the herd has since grown
    // from 16 to MAX_WILDLIFE. Forty animals on a 6-14s clock ask about four
    // times a second between them; without this the population raise alone
    // would have turned a paddock into a wall of noise.
    //
    // ...and the budget is spent only if a noise actually came out. `Audio.mob`
    // returns false for a species with no MOB_VOICE row, and that table has 9
    // animal entries against the 30 voiceless species this can be called for:
    // 13 of the 21 in SPAWN_BY_BIOME (polar, bee, tiger, lion, caterpillar,
    // giraffe, elephant, panda, monkey, beaver, dog, cat, crab), all four fish
    // and all thirteen monsters. Spending the world's one-call-per-second slot
    // on silence meant a mute animal throttled a cow standing beside it, and in
    // the desert — lion, caterpillar, bee — every species on the list is mute,
    // so the biome consumed the budget continuously and never made a sound.
    //
    // Strictly `=== false`, not falsy: an `onSound` that returns undefined is a
    // handler that made a noise as far as this is concerned, and treating that
    // as a refusal would disable the throttle entirely. Nothing runs away on
    // the false path either — the retry is on the mob's own 6..14s `voxT`, not
    // on the frame.
    if (this.onSound('idle', mob) === false) return;
    this.voxCooldown = 0.8 + Math.random();
    this.voxCount++;
  }

  /**
   * Keep bodies out of each other. Nothing did this before: the player could
   * stand exactly inside an animal, and a whole herd could pile onto a single
   * point — which is a large part of why they felt hollow even once they
   * stopped walking through terrain.
   *
   * A soft positional push rather than a hard stop, resolved in the tangent
   * plane. Hard collision between wandering animals gets them wedged; a nudge
   * proportional to how deep they overlap settles the herd apart on its own.
   *
   * This is also, and only, what keeps the camera out of an animal: Player.js
   * has no notion of mobs at all — it collides against blocks and nothing else
   * — so there is no two-way collision anywhere in the game and a player who
   * walks at a cow is never stopped. The cow is moved instead. That works,
   * because the push is proportional to penetration and at k ≈ 0.15 a frame it
   * clears a full body-radius in well under a second, i.e. faster than a sprint
   * closes it. Where it stops working is when _nudge refuses the move — an
   * animal backed against a wall has nowhere to yield to, and then the player
   * simply walks in. Fixing *that* means the player colliding with bodies, which
   * is not in this file.
   *
   * The pair loop used to be O(n²) — every body against every other, 8,911
   * tests a frame at the cap. It is a hash-grid lookup now (see the note on
   * _gHead); measured over bodies spread the way the spawner spreads them,
   * 266us a frame at 134 became 17us, and 2,540us at 400 became 84us. Packed
   * into herds, where the contact work is real rather than avoidable, 251us at
   * 134 became 27us and 2,619us at 400 became 204us — the remainder there is
   * _nudge doing work the old loop did too, not the lookup.
   * The squared-distance reject below still stands behind it
   * and still earns its place: the grid narrows the candidates to bodies within
   * one cell, and this rejects the ones that are in range of the cell but not
   * of each other. The world distance is a sound bound because flattening into
   * the tangent plane can only ever shorten the separation vector — so nothing
   * that would have been pushed is skipped.
   *
   * The pairs are visited in exactly the order the all-pairs loop visited them:
   * ascending `a`, and ascending `b` within each. That is not tidiness, it is
   * required. _nudge writes mob.cell.ci/cj and the next _footprintCost reads
   * them, so two pushes applied to one body in the other order settle it
   * somewhere else. Proven equal over 2,000 frames against the old loop, on the
   * exact sequence of (body, direction, amount) triples, to the bit.
   */
  _separate(dt, player) {
    const list = this.list;
    const k = Math.min(1, dt * 9);
    const n = list.length;

    // --- build the neighbour grid ---
    // The largest reach a pair can have. Recomputed each frame because it moves:
    // predators grow, and which species are inside the despawn ring changes as
    // the player walks.
    let maxR = 0;
    for (let i = 0; i < n; i++) {
      const m = list[i];
      if (!m.spec.phantom && m.radius > maxR) maxR = m.radius;
    }
    // 1e-3 only so an empty or all-phantom list cannot divide by zero.
    const inv = 1 / Math.max(2 * maxR, 1e-3);
    gridFit(n);
    const head = _gHead, next = _gNext, cx = _gCx, cy = _gCy, cz = _gCz;
    const cand = _gCand, mask = _gMask;
    head.fill(-1);
    for (let i = 0; i < n; i++) {
      const m = list[i];
      // He is not a body (see below), and nor is anything else phantom: leaving
      // them out of the grid is the same exemption the old loop spelled twice.
      if (m.spec.phantom) continue;
      const p = m.pos;
      const gx = Math.floor(p.x * inv), gy = Math.floor(p.y * inv), gz = Math.floor(p.z * inv);
      cx[i] = gx; cy[i] = gy; cz[i] = gz;
      const h = gridHash(gx, gy, gz) & mask;
      next[i] = head[h]; head[h] = i;
    }

    for (let a = 0; a < n; a++) {
      const m = list[a];
      // Not him. He is a sighting, not a body: nothing may push him and he may
      // push nothing.
      //
      // This was the one system he was not exempt from, and it is the one that
      // undoes him. Animals correctly do not fear him — `_buildThreats` leaves
      // him out — so they walk straight into him, and a herd nosing a silhouette
      // off the ridge that `_findStalkerSpot` chose for its sightline is the
      // exact opposite of the effect. `_nudge` would also slide him along terrain
      // he was placed on deliberately. The player half is unreachable in practice
      // (STALKER_VANISH collects him at 24 units, well outside touching range)
      // and is covered by the same line, which is where it belongs.
      if (m.spec.phantom) continue;
      // --- against the player ---
      _rel.copy(m.pos).sub(player.position);
      const up = m.up;
      // flatten into the animal's tangent plane so nobody gets shoved skyward
      _rel.addScaledVector(up, -_rel.dot(up));
      const want = m.radius + PLAYER_RADIUS;
      let d = _rel.length();
      // ...unless there is nobody standing there. A spectator passes through
      // the world, and a herd that parted around one would be the clearest
      // possible sign that the world can still feel them.
      if (d < want && !this.ghost) {
        if (d < 1e-4) { _rel.set(up.z, up.x, up.y).cross(up).normalize(); d = 1e-4; }
        else _rel.multiplyScalar(1 / d);
        // the animal yields; the player is not shoved around by livestock
        this._nudge(m, _rel, (want - d) * k);
      }
      // --- against each other ---
      // Everything within one cell on every axis, which is every body that
      // could possibly be overlapping this one.
      const gx = cx[a], gy = cy[a], gz = cz[a];
      let nc = 0;
      for (let dx = -1; dx <= 1; dx++) {
        const qx = gx + dx;
        for (let dy = -1; dy <= 1; dy++) {
          const qy = gy + dy;
          for (let dz = -1; dz <= 1; dz++) {
            const qz = gz + dz;
            for (let i = head[gridHash(qx, qy, qz) & mask]; i >= 0; i = next[i]) {
              // `i > a` is the old `b = a + 1`: each pair once, the later body
              // of the two doing the finding. The cell compare is what stops a
              // bucket shared by two neighbour cells returning a body twice.
              if (i > a && cx[i] === qx && cy[i] === qy && cz[i] === qz) cand[nc++] = i;
            }
          }
        }
      }
      // Ascending, for the ordering reason in the note above. Insertion sort
      // because nc is the number of bodies within a body-length or two — one or
      // two in open country, a handful in a herd — and a comparison sort's
      // setup costs more than this whole loop at that size.
      for (let i = 1; i < nc; i++) {
        const v = cand[i];
        let j = i - 1;
        while (j >= 0 && cand[j] > v) { cand[j + 1] = cand[j]; j--; }
        cand[j + 1] = v;
      }
      for (let c = 0; c < nc; c++) {
        const o = list[cand[c]];
        const reach = m.radius + o.radius;
        if (m.pos.distanceToSquared(o.pos) >= reach * reach) continue;
        _rel.copy(m.pos).sub(o.pos);
        _rel.addScaledVector(up, -_rel.dot(up));
        let d2 = _rel.length();
        if (d2 >= reach) continue;
        if (d2 < 1e-4) {
          _rel.set(Math.cos(m.id * 2.4), 0, Math.sin(m.id * 2.4));
          _rel.addScaledVector(up, -_rel.dot(up)).normalize();
          d2 = 1e-4;
        } else _rel.multiplyScalar(1 / d2);
        const push = (reach - d2) * k * 0.5;
        this._nudge(m, _rel, push);
        this._nudge(o, _rel, -push);
      }
    }
  }

  /** Shift a mob by `amount` along a world-space tangent direction. */
  _nudge(mob, dir, amount) {
    const fr = mob.frame;
    const di = (dir.x * fr.ea[0] + dir.y * fr.ea[1] + dir.z * fr.ea[2]) / fr.arcA;
    const dj = (dir.x * fr.eb[0] + dir.y * fr.eb[1] + dir.z * fr.eb[2]) / fr.arcB;
    // A layer index, not a height. This read `_groundUnder(...)`, which returns
    // the *height* of the surface — one more than the layer under the feet on
    // flat ground, and a fraction on anything shaped. `_footprintCost` passes
    // it to `_groundK` as `hereK + 1`, and a fractional start index means every
    // `solidAt` in that scan is asked about a layer that does not exist: all
    // nine samples came back gk < 0, cost 9, and the shove was refused outright.
    // So an animal standing on a slab, a stair tread or any half-height block
    // could not be pushed apart from its herd or yielded out of the player's
    // way at all — silently, because a refused nudge looks exactly like a body
    // with nowhere to go. The whole-block case was merely off by one, which let
    // a shove climb a step the animal could not have walked up.
    const here = this._refLayer(mob);
    const ni = mob.cell.ci + di * amount;
    const nj = mob.cell.cj + dj * amount;
    // never let a shove put an animal somewhere it could not have walked
    const cost = this._footprintCost(mob.cell.f, mob.cell.ci, mob.cell.cj, here, mob, mob.heading);
    const ok = (c2) => c2 === 0 || c2 < cost;
    if (ok(this._footprintCost(mob.cell.f, ni, mob.cell.cj, here, mob, mob.heading))) mob.cell.ci = ni;
    if (ok(this._footprintCost(mob.cell.f, mob.cell.ci, nj, here, mob, mob.heading))) mob.cell.cj = nj;
  }

  /** Does open sky reach this mob? Cheap column probe — see _findDarkColumn. */
  _skyLit(mob) {
    const col = this._colOf(mob.cell.f, mob.cell.ci, mob.cell.cj);
    return !this._roofed(col, Math.floor(mob.cell.ck));
  }

  /**
   * Hostile decision-making. Sets the desired heading and state, and swings
   * when close enough; the caller does the actual moving.
   *
   * @returns {boolean} true if it is hunting, so the wander logic stands down
   */
  _hunt(mob, dt, dist, player, fr) {
    const spec = mob.spec;
    // Aggro now needs a sight line to start (see ACQUIRE BY SIGHT below) but
    // still has no notion of whether the player can actually be *reached* — seen
    // across a ravine, they are ten cells away and unwalkable. A husk that
    // has been chasing for nine seconds without closing any ground is chasing
    // something on the other side of the rock, and standing there aggroed
    // forever is both eerie in the wrong way and a waste of a hostile slot.
    if (mob.huntCooldown > 0) {
      mob.huntCooldown -= dt;
      mob.target = null;
      // And the sighting that started the hunt expires with it. Otherwise a
      // husk that gave up on a walled player re-acquires the instant the
      // cooldown ends, off an answer it worked out fourteen seconds ago from
      // somewhere it is no longer standing.
      mob.sighted = false;
      mob.sightT = 0;
      return false;
    }
    // Losing interest at a longer range than it gains it stops a husk on the
    // edge of the aggro ring flickering between hunting and milling about.
    //
    // Only the husk acquires on sight. Every animal is handed its target from
    // somewhere else — hurt() when you swing at it, or _prowl at the end of a
    // night stalk — and by nothing else. Everything past this point is shared:
    // the chase, the stall test, the swing, because a provoked fox and a husk
    // want precisely the same thing once they have decided on you.
    // A monster hunts you the same way, which is the whole of what these two
    // have in common — the budgets and the dawn wipe stay husk-only.
    // Nobody is there to hunt. A spectator is not a target, not a threat and
    // not a thing to swing at, and refusing here rather than in five places is
    // what makes that true of the husk, the monster, the retaliating fox and
    // the committed night stalk at once — every one of them arrives at the
    // chase through this function.
    if (this.ghost) { mob.target = null; return false; }
    /**
     * Does this species decide about the player on its own?
     *
     * The husk and the monsters always have: coming for you unasked is the
     * whole of what they are for. Everything else is handed a target from
     * somewhere else — `hurt` when you swing at it, `_prowl` at the end of a
     * night stalk — and the note on `fights` explains at length why a world
     * where a lion attacks you for crossing a savanna is a smaller world.
     *
     * On a savage world it is a bigger one, because the deal has changed: a
     * death there is the end of the run, so the planet is allowed to be
     * something you cross carefully rather than something you walk through.
     *
     * The test is `preyOn && predator`, off the species table, and it is the
     * conjunction that makes it right rather than a list of names:
     *
     *   preyOn    it already hunts. The lists say a lion takes deer and cows,
     *             and the only change is that it will also take you. An animal
     *             with no prey list is not a hunter and does not become one —
     *             so the elephant and the bee, which fight but hunt nothing,
     *             stay exactly as provoked as they always were. Being dangerous
     *             when you start something is not the same as starting it.
     *   predator  it can actually land a blow, i.e. `fights` gave it damage,
     *             reach and a swing. The cat hunts chicks and cannot hurt
     *             anybody; a shark and a piranha hunt fish and deliberately
     *             have no `fights` at all ("a shark chases fish, not you"). An
     *             aggressive animal that cannot attack is not a threat, it is
     *             something following you about.
     *
     * Which lands on exactly five species: lion, tiger, polar bear, dog and
     * fox. Cub-shaped exceptions need no code — `_stalk` already refuses on
     * `baby`, and the chase below is the same one every other target uses.
     *
     * The ecology is untouched. `_stalk` still hunts the herd, prey still flees
     * predators through _spook and _comfort, and both of those read the species
     * table rather than this flag — a savage tiger is a tiger that has added
     * the player to a list it already had.
     */
    // ...and the cub exception does need code after all. The comment above says
    // `_stalk` already refuses on `baby`, which is true and is about the *herd*
    // hunt — this is the player hunt, and it had no such test anywhere, so on a
    // savage world a lion cub acquired the player and swung for the adult's
    // full damage. The test goes on the savage term alone: nothing hostile or
    // monstrous is ever born a cub.
    const acquires = spec.hostile || spec.monster
      || (this.savage && !!spec.preyOn && !!spec.predator && mob.baby <= 0);
    /**
     * ACQUIRE BY SIGHT, COMMIT BLIND. The rule, written down.
     *
     * The report is "a husk can find me even though I'm inside a block", and it
     * was true: aggro was a straight-line distance and nothing else, so a
     * player sealed in solid stone was as visible as one standing in a field.
     *
     * Minecraft's answer is worth copying because it is the one players already
     * have in their hands: a hostile *acquires* you by seeing you, inside a
     * radius; once it has you it keeps you through walls; and a sealed room is
     * safe because nothing can path to you, not because nothing can sense you.
     * Both halves matter. Sight-only would let you break a chase by stepping
     * behind a boulder, which makes every fight a game of peekaboo. Blind
     * acquisition is the bug.
     *
     * So: the line below is the only place in this file where a mob decides
     * about the player on its own, and it is now gated on a clear line. Every
     * other way in — `hurt` when you swing at one, `_prowl` at the end of a
     * night stalk — is a target being *handed* to it by something that already
     * knows the player is there, and none of them are gated, which is the
     * commit-blind half.
     *
     * A player who seals themselves in mid-chase is therefore still hunted, and
     * that is correct and costs them nothing: the husk cannot path in, HUNT_STALL
     * calls the hunt off after nine seconds of getting no closer, and `_blowClear`
     * refuses the blow in the meantime. Sealed ends with the player safe by
     * three independent mechanisms, and only the third of them is new.
     *
     * The eye is checked first and the ankles second, so a body in a dip or
     * behind a low lip is still seen by something standing over it — one ray
     * would make waist-high terrain a cloaking device.
     */
    if (acquires && mob.target !== 'player' && dist < spec.aggroRange) {
      mob.sightT -= dt;
      if (mob.sightT <= 0) {
        mob.sightT = SIGHT_PERIOD;
        this._headOf(mob, _eye);
        _ptB.copy(player.position).addScaledVector(player.up, PLAYER_EYE);
        mob.sighted = this._lineOfSight(_eye, _ptB);
        if (!mob.sighted) {
          _ptB.copy(player.position).addScaledVector(player.up, 0.4);
          mob.sighted = this._lineOfSight(_eye, _ptB);
        }
      }
    } else if (dist >= spec.aggroRange) {
      // Out of the ring: forget the last answer so re-entering re-asks rather
      // than inheriting a sighting from wherever it was standing before.
      mob.sighted = false;
      mob.sightT = 0;
    }
    if (acquires && mob.sighted && dist < spec.aggroRange) {
      if (mob.target !== 'player') { mob.bestDist = dist; mob.stallT = 0; }
      mob.target = 'player';
    } else if (dist > spec.aggroRange * 1.6) { mob.target = null; mob.sighted = false; }
    if (!mob.target) return false;

    // Only count the stall while it is still trying to *travel*. A husk stood
    // in your face swinging cannot improve its best distance either, and would
    // otherwise decide it was stuck and wander off mid-fight — the exact
    // opposite of what this is for.
    const closing = dist > spec.reach + mob.radius;
    // Walking a route counts as progress even though it is not closing the
    // straight-line gap — and often precisely because it is not. Getting out of
    // a three-sided pen means walking away from the player for eight or nine
    // cells, which is exactly what "nine seconds without getting any closer"
    // was written to catch. The two rules are individually sensible and
    // together they mean a husk gives up at the furthest point of every detour
    // it takes: measured on a pen, neither pathing nor not-pathing ever reached
    // the player, because the hunt was called off mid-way round. Consuming
    // waypoints is the honest measure of progress while a route exists.
    if (mob.onPath && mob.pathI > (mob.stallPathI ?? -1)) {
      mob.stallPathI = mob.pathI;
      mob.stallT = 0;
    }
    if (dist < mob.bestDist - 0.4) { mob.bestDist = dist; mob.stallT = 0; }
    else if (closing) {
      mob.stallT += dt;
      if (mob.stallT > HUNT_STALL) {
        mob.target = null;
        mob.huntCooldown = HUNT_COOLDOWN;
        mob.stallT = 0;
        mob.bestDist = Infinity;
        return false;
      }
    } else {
      mob.stallT = 0;
    }

    // Face the player, in the husk's own tangent frame so it stays correct
    // across a cube seam.
    _rel.copy(player.position).sub(mob.pos);
    const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
    const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
    mob.want = Math.atan2(rb, ra);

    // --- and the player has taken to the water ----------------------------
    //
    // "It should give up the moment I jump on the water and perhaps wait till
    // I get back in land." A land animal that follows you in does not swim: it
    // floats, because the `wading` rule in update() will not let it sink, and
    // the steering there is applied *after* this and overrides everything
    // decided here in favour of striking out for the nearest bank. So the
    // chase never resumed anyway — what the player saw was a tiger bobbing
    // about playing the run clip. Stopping at the edge is both better and
    // truer to the animal.
    //
    // A hold, not a give-up: the target is kept, so the moment you step back
    // onto land the ordinary chase picks up exactly where it left off with no
    // re-acquisition. That distinction is load-bearing for the provoked
    // species — only hurt() ever hands a tiger a target, so clearing it here
    // would mean a tiger could never resume at all, and you would have to
    // punch it a second time to get the fight back.
    //
    // It does not wait forever, and it needs no clock of its own. The stall
    // test above is already running and already means "nine seconds without
    // getting any closer"; holding is precisely that, so a mob that waits out
    // HUNT_STALL loses the target and takes HUNT_COOLDOWN off, while a player
    // who swims back toward it resets the clock and keeps it waiting. The one
    // number this needs was tuned years before the behaviour existed.
    //
    // Swimming, not paddling: `inWater` alone is read at the player's feet, so
    // it is true of ankle depth and a ford would have become an escape. Adding
    // `!grounded` is what separates "I am out of my depth" from "I am walking
    // through a stream", and a predator should absolutely follow you through a
    // stream.
    //
    // Amphibious and aquatic species are exempt, which is the whole meaning of
    // the flags: a polar bear fishes for a living and being followed into the
    // sea by one is the point of it.
    //
    // The husk is deliberately *not* exempt. Deep water is a refuge from it for
    // as long as you are willing to tread it, and it is waiting on the bank
    // when you get out — a better night than one spent being paddled after,
    // and it costs the player everything they could otherwise be doing with
    // that time, which is what keeps it from being a free win.
    if (!spec.aquatic && !spec.amphibious && this._playerAfloat(player)) {
      mob.state = 'idle';
      mob.stateT = 0.5;
      // No route to a swimmer, and the search is the expensive half of this
      // function. Clearing the flag rather than leaving it set keeps the stall
      // test above reading a path this mob is no longer walking.
      mob.onPath = false;
      return true;              // still hunting — just not following
    }

    // ...unless there is something in the way, in which case walk the route
    // rather than the bearing. The whisker probe further down can lean around a
    // boulder but has no idea a wall has a door in it twelve cells to the left;
    // it turns toward whichever whisker is clear and, against a long obstacle,
    // slides along it forever. A path knows about the door.
    const via = this._pathBearing(mob, dt, player, fr);
    if (via !== null) mob.want = via;

    // Close the distance, then stop and swing. Walking into the player would
    // shove them around — _separate already pushes bodies apart.
    //
    // Centre to centre, and it stays that way. The arithmetic was looked at
    // again because it is the real geometric cause of "their reach is longer
    // than one block": a husk pressed to one face of a wall settles with its
    // centre 0.05 outside it (the footprint test cares about the cell the
    // centre is in, not the radius) and the player's own half-width is 0.34, so
    // through one block the two centres can legally be 1.39 apart against a
    // reach of 1.25 + 0.576 = 1.826.
    //
    // Measuring from body *surfaces* instead was the obvious answer and is the
    // wrong one — it makes the reach longer, not shorter. Subtracting the
    // target's radius as well as the swinger's puts the husk at 1.25 + 0.576 +
    // PLAYER_RADIUS = 2.166, i.e. further through the wall than before. And the
    // other direction, cutting the effective reach under 1.39 so no wall can be
    // spanned at all, breaks blows that are plainly legitimate: measured, a
    // player standing on a husk's head is 1.78 away and a player up a one-block
    // step is 1.62, and both would stop landing.
    //
    // So the distance is left alone and the line is clipped at the first solid
    // cell instead — `_blowClear`, below and again at the contact frame. That
    // is the only test that can tell 1.39-through-stone from 1.39-in-the-open,
    // because they are the same number.
    const reach = spec.reach + mob.radius;
    // Close enough is not the same as able to. A body one block away through a
    // wall is inside every reach in the table, and swinging at the wall would
    // be both free damage and a mob visibly attacking masonry — so a blocked
    // hostile stays in 'chase' and lets `_pathBearing` go and look for the door.
    if (dist > reach || !this._blowClearPlayer(mob, player)) {
      mob.state = 'chase';
    } else {
      // 'idle' here means STANDING AND SWINGING, not doing nothing: a hostile
      // in range stops closing, and this is the state it stops in. Reading a
      // trace of a monster killing the player and seeing `state: 'idle'` on
      // every blow looks like the mob is asleep and the damage is coming from
      // somewhere else. The name is load-bearing elsewhere and not worth
      // churning; this note is the cheaper fix.
      mob.state = 'idle';
      if (mob.swingT <= 0) {
        mob.swingT = spec.swing;
        this._lunge(mob);
        // 'attack', not 'hurt'. This call site is the windup — the 0.28s
        // between deciding to swing and the blow landing is the only warning
        // the player gets — and it used to borrow the pain voice, so a monster
        // lunging at you and a monster taking a hit made the same noise at the
        // one moment the difference decides whether you block or step back.
        // Audio.mob has an 'attack' mode: same instrument, chest register
        // rather than pitched up, louder, and rising instead of falling.
        if (this.onSound) this.onSound('attack', mob);
        // The hit lands on the swing, not on the decision to swing, so there is
        // a moment to back out of range.
        this._pendingHits.push({ mob, at: 0.28, dmg: spec.damage });
      }
    }
    mob.stateT = 0.5;
    return true;
  }

  // --- pathfinding ----------------------------------------------------------

  /**
   * Bearing to the next waypoint of a route to the player, or null to just walk
   * at them.
   *
   * The route is recomputed on a timer rather than every frame, and only while
   * something is actually hunting — at most a handful of hostiles exist at once
   * and each search is bounded, so the whole system costs a few hundred
   * microseconds a second. Between searches the mob walks its existing path,
   * which is what stops it dithering when the player moves a step.
   */
  _pathBearing(mob, dt, player, fr) {
    const goal = this._colOf(player.cell.f, player.cell.ci, player.cell.cj);
    /*
     * Measured now, on the real planet, and the note that used to stand here
     * had the wrong suspect.
     *
     * It read: pathT is the one per-mob clock in this file that is not jittered
     * at spawn, so a husk pack that acquires the player together searches
     * together and re-syncs on PATH_PERIOD forever. True, and nearly harmless.
     * The line that actually cost the frames was `!mob.path`, which bypassed
     * the timer entirely — and `_findPath` returns null every time it cannot
     * reach the player, which for a hostile on the far side of water, a wall or
     * a cave roof is *every* search. So a husk that could not get to you ran a
     * full PATH_BUDGET search sixty times a second, not once per PATH_PERIOD.
     *
     * Headless on the real planet, ns timing, per-frame percentiles, one minute
     * of a savage night with the spawner running and the player walking at 4.4
     * units/s: 3,628 searches in 3,600 frames, essentially all of them
     * budget-exhausting, p50 1.13ms each. _findPath was 61.6% of the whole mob
     * tick — 1,419 frames over 1ms of pathing, 454 over 4ms, 108 over 8ms,
     * p99 28.9ms. Frames were being dropped by three husks that could not
     * reach anybody.
     *
     * Three changes, in the order they matter:
     *   1. `!mob.path` now waits for the timer like everything else, so a
     *      failed search costs one per PATH_PERIOD instead of one per frame.
     *      A body with no route is not stuck: `_hunt` set `mob.want` to the
     *      straight bearing before calling this, and a route only overrides it.
     *   2. PATH_PER_FRAME caps how many bodies may search in the same frame,
     *      which bounds the worst case whatever the clocks do.
     *   3. The period is jittered on each *reset* rather than at spawn, the way
     *      spookT is. That desynchronises a pack after its first search without
     *      the gameplay cost spawn-jitter would have had — seeding pathT would
     *      have delayed a newly-aggroed husk's first route by up to
     *      PATH_PERIOD, and this delays nothing.
     */
    mob.pathT = (mob.pathT ?? 0) - dt;
    const due = mob.pathT <= 0;
    const stale = mob.pathGoal !== goal && due;
    // A body that has never searched has pathT undefined, so `due` is true on
    // its first hunting frame and it still searches immediately.
    if (((!mob.path && due) || stale || mob.pathT <= -PATH_MAX_AGE)
        && this._pathBudget > 0) {
      this._pathBudget--;
      mob.pathT = PATH_PERIOD * (0.75 + Math.random() * 0.5);
      mob.pathGoal = goal;
      mob.path = this._findPath(mob, goal);
      mob.pathI = 0;
      // A fresh route restarts the progress clock, or the stall test would
      // compare waypoint indices from two different paths.
      mob.stallPathI = -1;
    }
    // Nothing is reset when the budget is out, so this body is still due and
    // takes the next free slot rather than losing its turn.
    const path = mob.path;
    mob.onPath = false;
    if (!path || mob.pathI >= path.length) return null;

    // Advance through waypoints we have already reached — after a jump or a
    // shove a mob can skip one, and steering back to it walks it backwards.
    const c = mob.cell;
    const here = this._colOf(c.f, c.ci, c.cj);
    for (let n = mob.pathI; n < Math.min(path.length, mob.pathI + 3); n++) {
      if (path[n] === here) mob.pathI = n + 1;
    }
    if (mob.pathI >= path.length) return null;

    // Aim several waypoints ahead, not at the next one. Waypoints are adjacent
    // columns, so steering at the very next one means steering at a point about
    // one body-length away: the mob overshoots it, turns back, overshoots
    // again, and crawls along the route oscillating — slowly enough that the
    // stall detector decides it is stuck and calls the hunt off. Looking
    // further down the path gives it a heading worth committing to, and the
    // corners still get taken because the waypoints are consumed in order.
    const aimAt = Math.min(mob.pathI + PATH_LOOKAHEAD, path.length - 1);
    const p = colParts(path[aimAt], _pp);
    cellToWorld(p.f, p.i + 0.5, p.j + 0.5, c.ck, _p);
    _rel.set(_p[0] - mob.pos.x, _p[1] - mob.pos.y, _p[2] - mob.pos.z);
    const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
    const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
    if (Math.abs(ra) < 1e-5 && Math.abs(rb) < 1e-5) return null;
    mob.onPath = true;
    return Math.atan2(rb, ra);
  }

  /**
   * A* over columns, from the mob to the player.
   *
   * Bounded three ways: a radius, a node budget, and a step limit. A husk that
   * cannot find a way through inside that budget gets null and falls back to
   * walking at the player and leaning around whatever it bumps into, which is
   * what it always did — so the worst case is the old behaviour rather than a
   * frame spike.
   *
   * @returns {number[]|null} columns from the first step to the goal
   */
  _findPath(mob, goal) {
    const start = this._colOf(mob.cell.f, mob.cell.ci, mob.cell.cj);
    if (start === goal) return null;
    const startK = this._groundK(start, Math.floor(mob.cell.ck) + 1, !!mob.spec.climbs);
    if (startK < 0) return null;

    const gScore = new Map([[start, 0]]);
    const kAt = new Map([[start, startK]]);
    const came = new Map();
    const open = new Heap();
    open.push(start, this._colDist(start, goal));
    let expanded = 0;

    while (open.size && expanded < PATH_BUDGET) {
      const cur = open.pop();
      if (cur === goal) return this._unwind(came, cur);
      expanded++;
      const g0 = gScore.get(cur);
      if (g0 >= PATH_MAX_STEPS) continue;
      const k0 = kAt.get(cur);
      for (let d = 0; d < 4; d++) {
        const nb = colNeighbor(cur, d);
        if (nb < 0) continue;
        const k1 = this._stepTo(nb, k0, mob);
        if (k1 < 0) continue;
        const g1 = g0 + 1;
        if (gScore.has(nb) && gScore.get(nb) <= g1) continue;
        gScore.set(nb, g1);
        kAt.set(nb, k1);
        came.set(nb, cur);
        open.push(nb, g1 + this._colDist(nb, goal));
      }
    }
    return null;
  }

  /**
   * Can a body standing on layer `fromK` walk into this column, and onto what?
   * @returns {number} the layer it would stand on, or -1 if it cannot go there
   */
  _stepTo(col, fromK, mob, rise = 1) {
    const p = this.planet;
    const gk = this._groundK(col, fromK + rise, !!mob.spec.climbs);
    if (gk < 0) return -1;
    if (gk - fromK > rise) return -1;              // too big a step up
    if (fromK - gk > PATH_MAX_DROP) return -1;     // too far to fall
    if (p.at(col, gk + 1) === ID.lava) return -1;  // and never through lava
    const wet = p.liquidAt(col, gk + 1);
    // Same exemption as the footprint test — the pathfinder has to agree with
    // it or a flier plans a route round a lake it is perfectly able to cross,
    // and a husk plans one round the ford it is standing in.
    if (mob.spec.aquatic ? !wet
      : (wet && !mob.spec.flies && !mob.spec.amphibious
         && !this._fordable(col, gk, this._wadeDepth(mob)))) return -1;
    for (let h = 1; h <= mob.tall; h++) {
      const above = p.at(col, gk + h);
      if (IS_SOLID[above] && !isPassable(above, p.facingAt(col, gk + h))) return -1;
    }
    return gk;
  }

  /** Straight-line distance between two column centres, in world units. */
  _colDist(a, b) {
    const pa = colParts(a, _pp);
    cellToWorld(pa.f, pa.i + 0.5, pa.j + 0.5, R_SEA - R_MIN, _p);
    const ax = _p[0], ay = _p[1], az = _p[2];
    const pb = colParts(b, _pp);
    cellToWorld(pb.f, pb.i + 0.5, pb.j + 0.5, R_SEA - R_MIN, _p);
    return Math.hypot(ax - _p[0], ay - _p[1], az - _p[2]);
  }

  _unwind(came, end) {
    const out = [];
    let cur = end;
    while (came.has(cur)) { out.push(cur); cur = came.get(cur); }
    out.reverse();
    return out.length ? out : null;
  }

  /**
   * A fed animal walks to the nearest other fed animal of its kind.
   *
   * `_tickBreeding` only ever *checked* whether two willing animals were within
   * BREED_RANGE; nothing moved them together, so a pair had to already be
   * within 4.5 cells when you fed them. Measured: two cows ten cells apart
   * closed to 9.7 over the whole 22-second window and never paired. Feeding
   * worked and breeding did not, unless the animals happened to be touching.
   *
   * @returns {boolean} true if it is walking to a mate, so wandering stands down
   */
  _court(mob, fr) {
    if (mob.love <= 0 || mob.baby > 0 || mob.breedCooldown > 0) return false;
    let best = null, bestD = COURT_RANGE * COURT_RANGE;
    for (const o of this.list) {
      if (o === mob || o.type !== mob.type) continue;
      if (o.love <= 0 || o.baby > 0 || o.breedCooldown > 0) continue;
      const d = mob.pos.distanceToSquared(o.pos);
      if (d < bestD) { bestD = d; best = o; }
    }
    if (!best) return false;
    // Close enough for _tickBreeding to pair them this frame; stop and let it.
    if (bestD <= BREED_RANGE * BREED_RANGE) { mob.state = 'idle'; mob.stateT = 0.4; return true; }

    _rel.copy(best.pos).sub(mob.pos);
    const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
    const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
    mob.want = Math.atan2(rb, ra);
    mob.state = 'chase';
    mob.stateT = 0.5;
    return true;
  }

  /**
   * The visible half of a blow.
   *
   * The Blocky Characters rig has a real swing; the Cube Pets pack does not
   * ship an attack clip for any of its twenty-odd animals, and there is nothing
   * to substitute that reads as a strike on its own. Left as it was — playOnce
   * against `spec.clips.attack`, which is undefined for a pet — the call is a
   * silent no-op, so a tiger's blow arrived with no animation, no pose change
   * and nothing on screen but the player's health going down.
   *
   * So a pet's lunge is built here out of what the pack does have: the run clip
   * fired once at nearly double speed for the pounce, plus a short scale pop in
   * _animate for the weight behind it. It is not an attack animation and does
   * not pretend to be one, but it is a tell, and a hit you cannot see coming is
   * worse than an approximate one.
   */
  _lunge(mob) {
    const clips = mob.spec.clips;
    const named = clips.attack && mob.model.actions[clips.attack];
    MobModels.playOnce(mob.model, named ? clips.attack : clips.run, named ? 1.35 : 2.1);
    mob.lungeT = LUNGE_TIME;
  }

  /**
   * Apply a predator's accumulated growth to the drawn model *and* to the body.
   *
   * Scale alone gives a grown tiger the silhouette of a big cat and the hitbox
   * of the kitten it started as — hittable only through the middle, and walking
   * through gaps its shoulders no longer fit.
   *
   * The footprint is scaled from the numbers measured at spawn rather than read
   * off the model again: modelExtents takes a world-space box, so once the
   * animal is out on the sphere — rotated, and a planet radius from the origin
   * — re-measuring returns the animal's *position*, not its size.
   *
   * The caps come from footCaps against the height this animal is *now* drawn
   * at, which is the same call modelExtents makes at spawn — `baseHeight` is
   * exactly the drawn height the box was measured from, so the two agree by
   * construction rather than by two copies of the same numbers staying in step.
   * A tiger that has eaten its way to GROW_MAX is drawn 30% larger and gets a
   * footprint 30% larger to match, which is the whole point of this function.
   */
  _setGrowth(mob, grown) {
    mob.grown = Math.min(GROW_MAX, Math.max(1, grown));
    const { capW, capL } = footCaps(mob.baseHeight * mob.grown);
    // The drawn width first, because that is what the cap is written against,
    // and the footprint from it — see FOOT_TUCK. A body restored from a save
    // written before `drawW` existed comes through here too, so the two can
    // never be left disagreeing.
    mob.drawW = Math.min(capW, mob.baseHalfW * mob.grown);
    mob.halfW = tuckW(mob.spec, mob.drawW);
    mob.halfL = Math.min(capL, mob.baseHalfL * mob.grown);
    mob.tall = Math.max(1, Math.ceil(mob.baseHeight * mob.grown - 0.001));
    // Grows with the rest of it. `?? 0` for a body restored from a save written
    // before this existed, where zero is also the right answer for every
    // species that had one — see `belly` in modelExtents.
    mob.belly = (mob.baseBelly ?? 0) * mob.grown;
  }

  /**
   * Something on this animal's own prey list, close by, that it could reach.
   *
   * The species list is the rule and everything else is a sanity check behind
   * it. That order matters: the old test was purely geometric — "anything at
   * most PREY_SIZE times my height" — and geometry cannot tell a deer from a
   * crab, so lions ate crabs, foxes ate bees and a cat would take a caterpillar
   * off a leaf. No amount of tightening the ceiling fixes that, because the
   * animals that are the wrong *kind* of prey are all over the size range.
   *
   * One pass over the whole list, which is bounded by MAX_MOBS and only run
   * every PREY_PERIOD per hungry carnivore — see the notes on those constants.
   */
  _findPrey(mob) {
    const preyOn = mob.spec.preyOn;
    if (!preyOn) return null;
    let best = null, bestD = PREY_RANGE * PREY_RANGE;
    const ceiling = mob.spec.height * mob.grown * PREY_SIZE;
    for (const o of this.list) {
      if (o === mob || o.taken || o.released || o.dying > 0 || o.health <= 0) continue;
      // Nothing hunts him. `preyOn` is written out by name and no list names
      // him, so this is already true — it is here because the lists are data
      // and "no one will ever add it" is not a guarantee, and because a tiger
      // padding across a valley towards a figure on a ridge is a story the
      // player would read as the two of them being in it together.
      if (o.spec.phantom) continue;
      if (!preyOn.has(o.type)) continue;
      // A calf of a listed species is still on the list; the checks below are
      // about what this individual can actually manage and reach.
      if (o.spec.height * o.grown > ceiling) continue;
      // Water is a wall to a land animal, so a fox that picks a fish spends the
      // whole PREY_GIVE_UP window padding along the shoreline looking stupid.
      // Cheaper to never choose it than to detect the failure afterwards. A
      // polar bear is on the fish's side of this because it swims — which is
      // why it is amphibious rather than simply having fish on its list.
      const wetPrey = !!(o.spec.aquatic);
      const canSwim = !!(mob.spec.aquatic || mob.spec.amphibious);
      if (wetPrey && !canSwim) continue;
      if (!wetPrey && mob.spec.aquatic) continue;
      // Height is a wall in exactly the same way water is. A cat has bees on
      // its list, and a bee holds station `hover` (1.5) above the ground, which
      // is further than a cat's reach plus both radii — so the cat could pick
      // one, chase it for the full PREY_GIVE_UP window and never once be close
      // enough to take it. It never showed while bees were rare; with fliers on
      // their own budget there are fourteen of them and it would.
      if (o.spec.flies && !mob.spec.flies) continue;
      // And a canopy is the third wall, on exactly the same grounds. The monkey
      // is the only `climbs` species and foliage is floor to it alone, so a
      // monkey sitting in the branches is as unreachable to a lion as a bee is
      // to a cat — and the lion, having no rule about it, would pick it and pad
      // about under the tree for the whole PREY_GIVE_UP window. `climbTo` is
      // the ascent and `perchT` the sit at the top; either means it is not on
      // the ground. Nothing stops a hunter taking the same monkey once it comes
      // down, which is the outcome the water and air rules also produce.
      if ((o.climbTo !== null || o.perchT > 0) && !mob.spec.climbs) continue;
      const d = mob.pos.distanceToSquared(o.pos);
      if (d >= bestD) continue;
      // And terrain is the fourth wall, the one the three above are all
      // instances of. Water, air and a canopy were each written down because a
      // hunter that picks something it cannot get to spends the whole
      // PREY_GIVE_UP window looking stupid; a block of stone does exactly the
      // same and had no rule. Measured: a fox with a rabbit six blocks of stone
      // away held it as prey on 3350 frames of 3600 and stayed in 'chase' for
      // 3470 of them, which is one minute of a fox walking into a wall.
      //
      // Last of all the tests on purpose. It is the only one that touches the
      // voxels, and putting it behind the distance improvement means it is
      // asked once per candidate that is actually winning rather than once per
      // animal on the planet — typically one or two marches per search, and a
      // search is one per PREY_PERIOD (1.6s) per hungry carnivore with nothing
      // yet chosen.
      //
      // Only the *choice* is gated. A hunt already under way is not re-tested,
      // exactly as `_hunt` keeps a target it has committed to: prey that breaks
      // line of sight behind a boulder should be chased round it, and the bite
      // at the end of that chase is refused by `_blowClear` in `_stalk` anyway.
      if (!this._sightClear(mob, o.pos, o.up, o.spec.height)) continue;
      bestD = d; best = o;
    }
    return best;
  }

  /**
   * Everything on the planet that could frighten anything, in one pass.
   *
   * Run once per THREAT_PERIOD for the whole world rather than once per animal:
   * the alternative — every prey animal walking this.list for itself — is the
   * O(n²) pass the hunt scan's own comment exists to avoid, and there are far
   * more prey than predators, so the cheap half is the one to share.
   *
   * `preyOn` is the test rather than `diet`, because "hunts something" is what
   * matters and an omnivore with a list is as dangerous as a carnivore with
   * one. Husks are in as well: they have no prey list and no interest in
   * animals, but a deer that grazes through one is the same picture in a
   * different hat, and _spook's unlisted weight already prices it as wariness.
   */
  _buildThreats() {
    const out = this._threats;
    out.length = 0;
    for (const o of this.list) {
      const s = o.spec;
      // He frightens exactly one thing and it is not the wildlife. Same rule as
      // _findPrey's, and for the same reason: the lists are data.
      if (s.phantom || s.trader) continue;
      if (o.taken || o.released || o.dying > 0 || o.health <= 0) continue;
      // A cub is not a threat. It cannot hunt — _stalk refuses on `baby` — so
      // treating it as one would have a herd bolting from a kitten.
      if (o.baby > 0) continue;
      if (!s.preyOn && !s.hostile && !s.monster) continue;
      out.push(o);
    }
  }

  /**
   * How close `p` is willing to let `t` get, in cells, or 0 if `t` is nothing
   * to it. Centre to centre, so both bodies' radii are in it.
   *
   * Built entirely out of numbers that already exist. The gate is _findPrey's
   * own ceiling — if this thing could not physically take me there is nothing
   * to be afraid of, which is what makes a fox beside a deer a non-event
   * without anybody writing "foxes do not scare deer" down anywhere. The width
   * is the damage ladder, scaled by how much bigger than me it is.
   */
  _comfort(t, p) {
    const ts = t.spec, ps = p.spec;
    if (t === p || t.type === p.type) return 0;
    // Water and air are walls in both directions, exactly as they are in
    // _findPrey: a shark cannot come ashore and a deer is not a bee's problem.
    if (ts.aquatic && !ps.aquatic) return 0;
    if (ps.aquatic && !(ts.aquatic || ts.amphibious)) return 0;
    if (ps.flies && !ts.flies) return 0;
    const th = ts.height * t.grown, ph = ps.height * p.grown;
    // The prey-ceiling rule, from the hunter's side. Above it, I am simply too
    // big to be dinner.
    if (ph > th * PREY_SIZE) return 0;
    // A hunter is not frightened of something no bigger than itself.
    //
    // Without this the rule above is the only one, and it admits anything
    // within half again my height — which for two animals of the same guild is
    // mutual. Both directions then hold at once: a lion (1.45) and a tiger
    // (1.60) each bolt from the other, a fox (0.58) and a dog (0.78) each bolt
    // from the other, and a fox bolts from a *cat*, which has no `fights` at
    // all and gets the default threat weight of a dog for having none. Two
    // resting big cats on a badlands list that contains both became a bolt-and-
    // alarm metronome on a seven-second cycle.
    //
    // `predator` and not `preyOn`, deliberately: the flag means this animal
    // fights, and that is what makes standing its ground plausible. A cat has
    // prey and no fight, so a cat still fears the dog — and no longer
    // frightens the fox.
    if (ps.predator && th <= ph) return 0;
    const weight = (ts.preyOn && ts.preyOn.has(p.type)) ? 1 : SPOOK_UNLISTED;
    const size = clamp(0.6 + 0.4 * (th / Math.max(0.2, ph)), SPOOK_SIZE_MIN, SPOOK_SIZE_MAX);
    const r = (SPOOK_BASE + SPOOK_PER_DMG * (ts.damage ?? 2)) * size * weight;
    return Math.min(r, SPOOK_MAX) + t.radius + p.radius;
  }

  /**
   * Point `mob` away from a world position and set it running.
   *
   * Except when the way out is blocked and something has already picked a way
   * round. This runs every frame a bolt is live, so a bearing straight into a
   * river or a cliff was re-asserted every frame and the deflection _walkStep
   * chose never survived long enough to be taken — the animal faced the water
   * and sprinted on the spot, which is what the shoreline report describes.
   * `slideT` is that deflection's own clock and it is short; while it runs the
   * body keeps the heading that is actually walkable and still ends up going
   * away from the threat, because that is the side the deflection came from.
   */
  _boltAway(mob, from, jitter) {
    if (mob.slideT > 0) {
      mob.state = 'flee';
      mob.stateT = Math.max(mob.stateT, 0.6);
      return;
    }
    const fr = mob.frame;
    _rel.copy(mob.pos).sub(from);
    const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
    const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
    mob.want = wrapAngle(Math.atan2(rb, ra) + jitter);
    mob.state = 'flee';
    // Long enough that the wander cannot take the state back between looks, and
    // refreshed every frame the bolt is live, so the two clocks cannot fight.
    mob.stateT = Math.max(mob.stateT, 0.6);
  }

  /**
   * An animal notices a predator standing near it, and eventually leaves.
   *
   * The counterpart to _stalk, and independent of it on purpose: nothing here
   * asks whether the predator is hungry, has chosen a target, or is even awake.
   * A tiger that has just eaten is still a tiger.
   *
   * @returns {boolean} true if it is bolting, so the wander stands down
   */
  _spook(mob, dt) {
    const spec = mob.spec;
    // Who has no nerves: the stalker (nothing about him is ordinary), the
    // merchant (he is here to trade and a shopkeeper who runs into the trees
    // takes the shop with him — the same exemption _stalk already gives him),
    // and the husk, which is a corpse with a grudge.
    if (spec.phantom || spec.trader || spec.hostile || spec.monster) return false;
    if (mob.spookRest > 0) mob.spookRest -= dt;

    // --- already running ---
    if (mob.bolt > 0) {
      mob.bolt -= dt;
      const t = mob.boltFrom;
      const alive = !!t && !t.taken && !t.released && t.dying <= 0 && t.health > 0;
      if (alive) {
        const comfort = this._comfort(t, mob);
        const d = mob.pos.distanceTo(t.pos);
        if (comfort <= 0 || d > comfort * SPOOK_CLEAR) {
          // Clear of it, with the hysteresis margin. A short breather rather
          // than none, so it does not immediately re-arm on the way back in.
          mob.bolt = 0; mob.boltFrom = null; mob.spook = 0;
          mob.spookRest = SPOOK_EASE;
          return false;
        }
        if (mob.bolt <= 0) {
          // Six seconds and still inside the ring. Either it is cornered or the
          // thing is faster than it, and in both cases more sprinting achieves
          // nothing — except when it is genuinely being hunted, where standing
          // still is not a choice an animal gets to make. _stalk keeps driving
          // that case anyway; this only declines to stop it.
          if (t.prey === mob) { mob.bolt = SPOOK_HOLD; }
          else {
            mob.bolt = 0; mob.boltFrom = null; mob.spook = 0;
            mob.spookRest = SPOOK_REST + Math.random() * SPOOK_REST_VAR;
            return false;
          }
        }
        this._boltAway(mob, t.pos, 0);
        return true;
      }
      // Running from a remembered place — an alarm bolt, or a threat that died
      // mid-flight. It runs out the clock and stops.
      if (mob.bolt <= 0) {
        mob.bolt = 0; mob.boltFrom = null; mob.spook = 0;
        mob.spookRest = SPOOK_EASE;
        return false;
      }
      this._boltAway(mob, mob.boltAt, 0);
      return true;
    }

    // --- otherwise, a look round, on its own clock ---
    mob.spookT -= dt;
    if (mob.spookT > 0) return false;
    mob.spookT = SPOOK_PERIOD * (0.8 + Math.random() * 0.4);
    if (!this._threats.length && !this._alarms.length) { mob.spook = 0; return false; }

    let worst = null, depth = 0;
    for (const t of this._threats) {
      if (t === mob || t.taken || t.dying > 0 || t.health <= 0) continue;
      const comfort = this._comfort(t, mob);
      if (comfort <= 0) continue;
      const d2 = mob.pos.distanceToSquared(t.pos);
      if (d2 >= comfort * comfort) continue;
      // How far inside the ring, 0 at the edge and 1 on top of it. The worst
      // threat is the one that has come furthest in, not the nearest — a fox at
      // three cells is deeper into its own small ring than a tiger at five is
      // into a wide one, and the fox is the one to step away from first.
      const u = 1 - Math.sqrt(d2) / comfort;
      if (u <= depth) continue;
      // ...and it has to be able to see the thing. A wall between them is the
      // whole point of a wall, and without this a penned herd bolted from a
      // predator on the far side of the fence: measured at 1444 bolt frames of
      // 3600 through six blocks of stone, which is the identical number the
      // same pair produce on open ground.
      //
      // Behind the `u > depth` test so it costs one march per candidate that is
      // actually the worst so far, and the loop only reaches here for a threat
      // already inside the comfort ring — usually none, so usually no march at
      // all. The scan itself is one per SPOOK_PERIOD (0.75s) per animal.
      //
      // `depth` drives the panic override as well as the choice, so a threat
      // behind a wall correctly contributes no panic either.
      if (!this._sightClear(mob, t.pos, t.up, t.spec.height)) continue;
      depth = u; worst = t;
    }

    const step = SPOOK_PERIOD;
    if (worst) mob.spook += (SPOOK_FILL + depth) * step;
    else mob.spook = Math.max(0, mob.spook - SPOOK_DECAY * step);

    // The herd cue, and only when it cannot see anything itself — an animal
    // with a tiger in front of it does not need to be told. Half a trigger's
    // worth, so it tips over a neighbour that was already uneasy and does
    // nothing at all to a calm one.
    let alarm = null;
    if (!worst && this._alarms.length) {
      for (const a of this._alarms) {
        if (a.mob === mob) continue;
        if (mob.pos.distanceToSquared(a.pos) > ALARM_RANGE * ALARM_RANGE) continue;
        mob.spook += ALARM_WEIGHT;
        alarm = a;
        break;
      }
    }

    // Deep inside the ring is the one thing that overrides the wary pause. A
    // deer that gave up and settled, with a tiger then walking up to its
    // shoulder, is the report again.
    const panic = depth > SPOOK_PANIC;
    if (mob.spook < SPOOK_TRIGGER || (mob.spookRest > 0 && !panic)) {
      mob.spook = Math.min(mob.spook, SPOOK_TRIGGER * 1.5);
      return false;
    }

    mob.spook = 0;
    mob.spookRest = 0;
    if (worst) {
      mob.bolt = SPOOK_HOLD;
      mob.boltFrom = worst;
      mob.boltAt.copy(worst.pos);
      // Only a first-hand sighting raises the alarm. An alarm bolt that raised
      // one of its own is a chain reaction with no damping in it, and the far
      // side of the meadow would be running from a rumour.
      if (this._alarms.length < ALARM_MAX) {
        this._alarms.push({ pos: mob.pos.clone(), mob, t: ALARM_LIFE });
      }
    } else if (alarm) {
      // Off a neighbour's word alone: a short break in the same direction it
      // went, not a committed escape from something it has not seen.
      mob.bolt = ALARM_BOLT;
      mob.boltFrom = null;
      mob.boltAt.copy(alarm.pos);
    } else {
      return false;
    }
    // A shared bearing per animal would line a herd up like a chorus; a little
    // spread keeps it a scatter.
    this._boltAway(mob, mob.boltAt, (Math.random() - 0.5) * 0.8);
    return true;
  }

  /**
   * The night stalk: a hungry big cat walks the player down, slowly, and says
   * so for six seconds before it means it.
   *
   * Kept out of _hunt on purpose. _hunt is the committed chase — full speed,
   * pathfinding, swinging — and the whole point of this is to be the opposite
   * of that for as long as the telegraph lasts. It ends by handing _hunt a
   * target, which is the same door hurt() uses, so there is exactly one chase
   * implementation and this only decides when to open it.
   *
   * @returns {boolean} true if it is prowling, so everything else stands down
   */
  /*
   * ...and why a savage world has no night stalk in it.
   *
   * The telegraph is the whole feature: six seconds of a cat creeping at half
   * speed is what turns one unprovoked attack a night from a betrayal into an
   * event, and it is legible precisely because it is rare and because nothing
   * else on the planet comes for you. On a world where every big cat is already
   * walking at you the moment it sees you, a creep is not a warning about
   * anything — it is one cat out of five behaving more politely than the rest,
   * and it costs the player the only thing the stalk was buying them, which is
   * the six seconds. The savage rule is the stronger statement of the same
   * idea, and the two would only get in each other's way: a stalk that started
   * would *slow the cat down*, holding it at PROWL_HOLD while _hunt stood down.
   */
  _prowl(mob, dt, dist, player, fr) {
    const spec = mob.spec;
    if (!spec.stalks) return false;
    // Already committed — _hunt owns the chase from here, and this is only
    // watching for the reasons to let go of it.
    if (mob.stalked) {
      // Daylight calls it off: the night is what made it brave, and a cat that
      // keeps coming at sunrise is the unprovoked attack again with extra
      // steps. Losing the target any other way — the stall test, or simply
      // outrunning it — also ends the stalk, and the rest afterwards is what
      // stops one cat trying the same thing twice in a minute.
      if (this.daylight > 0.06 || mob.target !== 'player') {
        mob.stalked = false;
        mob.target = null;
        mob.hungerT = PREY_REST_MIN + Math.random() * (PREY_REST_MAX - PREY_REST_MIN);
      }
      return false;
    }

    // Nothing starts a stalk on a swimmer. _hunt will only hold at the water's
    // edge the instant the cat commits, so a stalk begun on someone treading
    // water is a full telegraph — growl, creep, the lot — spent to arrive at a
    // standstill, and it burns the hunger clock doing it.
    const afloat = this._playerAfloat(player);
    const eligible = !this.ghost               // ...and somebody is there at all
      && !this.savage                          // see below
      && this.daylight < 0.02                  // night, where the player stands
      && mob.hungerT <= 0                      // and hungry, on the hunting clock
      && mob.baby <= 0 && mob.love <= 0
      && !mob.prey && mob.target !== 'player'
      && !afloat
      && dist < PROWL_RANGE;
    if (mob.prowl <= 0) {
      if (!eligible) return false;
      // The roll belongs to the planet, not to this animal: one per
      // PROWL_PERIOD however many cats are eligible, and none at all while the
      // last stalk is still resting off. Resetting the period *here*, on the
      // frame the roll is actually taken rather than in update(), is what keeps
      // it one roll per period instead of one per cat per period — the first
      // eligible cat the loop reaches spends it, and every other cat this frame
      // finds the clock already restarted.
      if (this.prowlRest > 0 || this.prowlT > 0) return false;
      this.prowlT = PROWL_PERIOD;
      if (Math.random() >= PROWL_CHANCE) return false;
      // ...on somebody it can see. This is the third blind acquisition and the
      // loudest of them: measured before the test, a tiger outside a sealed
      // 1x1x2 stone pocket telegraphed at the player inside it for 2880 frames
      // and held them as a target for 4306, growling every PROWL_GROWL through
      // solid rock. `_blowClear` refused every blow, so it cost no health at
      // all — it just meant the one thing in the game a shelter is for did not
      // work, which is the report.
      //
      // Here rather than in `eligible` above because `eligible` is evaluated
      // every frame for every big cat and this is a march of up to PROWL_RANGE
      // (26 cells). Behind the roll it runs at most once per PROWL_PERIOD for
      // the whole planet. The roll is still spent — `prowlT` is reset above —
      // so a blocked cat does not burn PROWL_REST and the next period tries
      // again, which is what "one roll per period" already means.
      if (!this._sightClear(mob, player.position, player.up, PLAYER_HEIGHT)) return false;
      this.prowlRest = PROWL_REST;
      mob.prowl = PROWL_TELL;
      mob.growlT = 0;
    } else if (this.daylight > 0.06 || dist > PROWL_RANGE * 1.5
      || mob.target === 'player' || afloat) {
      // The sun came up mid-telegraph, or you left, or you took to the water,
      // or — the case worth spelling out — you shot first. A player who answers the
      // tell with an axe has ended the telegraph by definition, and a cat that
      // went on creeping politely through being hit would make the tell read as
      // scenery. hurt() has already set the target; drop the stalk and let the
      // ordinary provoked chase have it.
      mob.prowl = 0;
      mob.creep = false;
      mob.hungerT = PREY_REST_MIN * 0.5;
      return false;
    }

    mob.prowl -= dt;
    // The audible half of the tell. 'attack' is the aggressive call — the same
    // one a lunge uses — and it is deliberately not rate-limited through
    // _tryVocalise: this is the one noise in the game the player must not miss.
    // It was 'hurt' until the voice table grew an aggression mode of its own; a
    // stalking lion that sounds like a wounded one is the wrong warning.
    mob.growlT -= dt;
    if (mob.growlT <= 0) {
      mob.growlT = PROWL_GROWL;
      if (this.onSound) this.onSound('attack', mob);
    }

    if (mob.prowl <= 0) {
      // Committed. From here it is an ordinary provoked predator, and _hunt
      // takes it over on this very frame — hence the false.
      mob.creep = false;
      mob.stalked = true;
      mob.target = 'player';
      mob.bestDist = dist;
      mob.stallT = 0;
      mob.huntCooldown = 0;
      return false;
    }

    // The visible half: face you, and close at half a walk rather than a run,
    // stopping a few cells short. A charge at this range would be over before
    // the telegraph meant anything.
    _rel.copy(player.position).sub(mob.pos);
    const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
    const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
    mob.want = Math.atan2(rb, ra);
    mob.creep = true;
    mob.state = dist > PROWL_HOLD ? 'walk' : 'idle';
    mob.stateT = 0.4;
    return true;
  }

  /**
   * A carnivore stalks the herd.
   *
   * Steering is the same code the player-hunt and the courtship use — point
   * `want` at something and set state to 'chase' — because the movement in this
   * file is the hard-won part and a second copy of it would rot immediately.
   *
   * @returns {boolean} true if it is stalking, so wandering stands down
   */
  /**
   * How fast this hunter runs at the animal it is chasing, as a multiple of its
   * own amble. See PREY_CLOSE for the whole argument.
   *
   * Off the prey's *species* pace rather than its current speed on purpose: a
   * bolt is what it will be doing the moment it notices, and steering a chase
   * by what the prey happens to be doing this frame would have the hunter slow
   * to a walk every time its dinner paused, which is a hunter that never
   * arrives and looks like one that has changed its mind.
   */
  _huntPace(mob) {
    const prey = mob.prey;
    if (!prey) return CHASE_SPEED;
    const flee = prey.spec.speed * FLEE_SPEED;
    return clamp((flee + PREY_CLOSE) / mob.spec.speed, CHASE_SPEED, PREY_CHASE_MAX);
  }

  /**
   * What one bite takes off this particular animal. See PREY_BITES.
   *
   * `spec.health` and not the individual's current health, so the count is
   * bites-to-kill from full and a wounded animal dies sooner rather than the
   * hunt stretching to the same two bites however hurt it already was.
   */
  _preyBite(mob, prey) {
    const own = mob.spec.damage ?? 0;
    return Math.max(1, own, Math.ceil((prey.spec.health ?? 4) / PREY_BITES));
  }

  _stalk(mob, dt) {
    const spec = mob.spec;
    if (!spec.preyOn) return false;
    if (spec.diet !== 'carnivore' && spec.diet !== 'omnivore') return false;
    // (The bite cooldown and the hunger clock are ticked in update() now, with
    // the rest of this body's clocks. They were ticked here, which meant they
    // only ran on the frames this function was reached — and it is not reached
    // at all while the animal is hunting the player or telegraphing a night
    // stalk. On a savage world every carnivore inside its aggro range is
    // permanently locked onto the player, so its hunger stopped where it stood:
    // one that had just eaten stayed full for as long as the player was in
    // sight, and one that was hungry when they arrived was still exactly as
    // hungry when they left. A clock that only runs while nothing is happening
    // is not a clock.)
    // A cub does not hunt, and a fed animal has other plans.
    if (mob.baby > 0 || mob.love > 0) return false;
    if (mob.hungerT > 0) { mob.prey = null; return false; }

    if (mob.prey && (mob.prey.taken || mob.prey.released
      || mob.prey.dying > 0 || mob.prey.health <= 0)) mob.prey = null;
    mob.preyT -= dt;
    if (mob.preyT <= 0) {
      mob.preyT = PREY_PERIOD;
      if (!mob.prey) { mob.prey = this._findPrey(mob); mob.preyChase = 0; }
    }
    const prey = mob.prey;
    if (!prey) return false;

    const d = mob.pos.distanceTo(prey.pos);
    if (d > PREY_RANGE * 1.6) { mob.prey = null; return false; }
    mob.preyChase += dt;
    if (mob.preyChase > PREY_GIVE_UP) {
      // Some hunts fail. Resting after a failure as well as after a kill is
      // what stops a carnivore latching straight onto the next animal in the
      // same second and towing the whole herd across the map behind it.
      mob.prey = null;
      mob.hungerT = PREY_REST_MIN * 0.4;
      return false;
    }

    // Being hunted is the prey's business too — a herd that grazes on while it
    // is eaten looks worse than no ecology at all. It is told directly rather
    // than left to find out with a scan of its own: the hunter already knows
    // who it is chasing, so this costs nothing, and the flee state it sets is
    // the same one a swung axe sets.
    const pf = prey.frame;
    if (d < PREY_RANGE * 0.55 && prey.state !== 'flee' && !prey.spec.trader) {
      _rel.copy(prey.pos).sub(mob.pos);
      prey.state = 'flee';
      prey.stateT = 1.4 + Math.random();
      prey.want = Math.atan2(
        _rel.x * pf.eb[0] + _rel.y * pf.eb[1] + _rel.z * pf.eb[2],
        _rel.x * pf.ea[0] + _rel.y * pf.ea[1] + _rel.z * pf.ea[2],
      );
    }

    const fr = mob.frame;
    const reach = (spec.reach ?? 1.0) + mob.radius + prey.radius;
    // The body-to-body half of the same bug, and the one that was actually
    // measured: a fox reaches 1.26, a rabbit half a cell the other side of one
    // block is 1.0 away, so foxes ate through walls. Blocked counts as out of
    // reach — the hunter keeps chasing, and if there is a door it will find it.
    if (d > reach || !this._blowClear(mob, prey.pos, prey.up, prey.spec.height)) {
      _rel.copy(prey.pos).sub(mob.pos);
      mob.want = Math.atan2(
        _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2],
        _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2],
      );
      mob.state = 'chase';
      mob.stateT = 0.5;
      return true;
    }

    // In reach, but not yet allowed to bite again: keep after it. Returning
    // here rather than falling through is the whole point of BITE_PERIOD — the
    // hunter stays on the prey's heels and the wound has a moment to read.
    if (mob.biteT > 0) {
      mob.state = 'chase';
      mob.stateT = 0.5;
      return true;
    }

    // Contact. The body is *not* removed here: this runs from inside the update
    // loop's reverse walk over this.list, and splicing an entry below the
    // cursor shifts everything under it, so a mob gets ticked twice or skipped.
    // It is marked and collected after the loop instead.
    this._lunge(mob);
    mob.biteT = BITE_PERIOD;

    /**
     * A bite, not a deletion.
     *
     * Contact used to end the animal outright, whatever it was: a lion reaching
     * a deer removed it on the frame it touched it, so predation had no middle
     * and nothing ever got away. Now the lunge costs the prey PREY_BITES-worth
     * of itself, and one with health left bolts — so a kill takes two passes
     * and the chase is the part you watch.
     *
     * Health is decremented here rather than through `_damage` on purpose. That
     * calls `_die`, which splices the list, and this runs inside the update
     * loop's reverse walk — removing an entry under the cursor is what the
     * comment above is about. The `_kills` list exists precisely so a death is
     * collected after the loop, so a fatal bite goes there exactly as before.
     */
    prey.health -= this._preyBite(mob, prey);
    prey.hurtT = 0.25;
    if (prey.health > 0) {
      if (this.onSound) this.onSound('hurt', prey);
      // It breaks away. The hunter has to close again, which is what turns a
      // kill into a chase, and the pause stops it re-biting on the next frame.
      prey.state = 'flee';
      prey.stateT = 2.5;
      prey.speedNow = prey.spec.speed * FLEE_SPEED;
      // PREY_GIVE_UP measures a hunt that is getting nowhere, and a hunter with
      // its teeth in something is not getting nowhere. Without this the window
      // has to pay for the closing run AND for every bite after it, so the
      // slowest hunters were timed out mid-meal — which is the one moment a
      // predator visibly gives up that no player would read as a decision.
      mob.preyChase = 0;
      mob.preyT = PREY_PERIOD;
      mob.state = 'chase';
      mob.stateT = 0.6;
      return true;
    }

    prey.taken = true;
    this._kills.push(prey);
    mob.prey = null;
    // Nothing drops. It ate the animal — a rabbit bursting into hide and meat
    // for the player to walk over would make every predator a free larder and
    // hunting them the fastest way to farm.
    this._feed(mob);
    if (this.onSound) this.onSound('hurt', prey);
    mob.state = 'idle';
    mob.stateT = 0.6 + Math.random();
    // A carnivore that has just eaten stops caring about you as well. Being
    // chased by a tiger that has visibly stopped to eat something else is the
    // moment the ecology reads as an ecology rather than as two systems.
    if (!spec.hostile) mob.target = null;
    return true;
  }

  /** A kill: grow a little, and be full for a while. */
  _feed(mob) {
    mob.kills++;
    this._setGrowth(mob, mob.grown + GROW_PER_KILL);
    mob.hungerT = PREY_REST_MIN + Math.random() * (PREY_REST_MAX - PREY_REST_MIN);
  }

  /** Resolve attack swings whose contact frame has arrived. */
  _resolveHits(dt, player) {
    for (let n = this._pendingHits.length - 1; n >= 0; n--) {
      const h = this._pendingHits[n];
      h.at -= dt;
      if (h.at > 0) continue;
      this._pendingHits.splice(n, 1);
      // The mob may have died or been knocked away between swing and contact.
      if (h.mob.health <= 0 || h.mob.dying > 0) continue;
      const reach = h.mob.spec.reach + h.mob.radius + 0.35;
      if (h.mob.pos.distanceTo(player.position) > reach) continue;
      // Asked again at the contact frame rather than trusted from the decision
      // to swing, because 0.28s is long enough to step behind a block — and
      // because this is the one door every blow on the player comes through, so
      // gating it here is what makes "no blow passes through terrain" a property
      // of the system rather than of one call site.
      if (!this._blowClearPlayer(h.mob, player)) continue;
      if (this.onAttack) this.onAttack(h.dmg, h.mob);
    }
  }

  /**
   * The worst spiky thing this body is actually touching, or 0.
   *
   * The player's `contactHurt` grows its collision box and tests every cell it
   * overlaps. A mob has no box — it has a radius and a footprint test that
   * already refuses to walk into solid ground — so this asks the simpler
   * question that fits the shape: is there a hurting block in one of the five
   * columns under and around the body, at a layer the body spans, close enough
   * horizontally that the spines reach.
   *
   * Distance is measured to the *cell*, not to its centre: a cactus fills its
   * column, so the nearest point of it is the column edge, and measuring to the
   * middle would let a cow stand half inside one unharmed.
   *
   * @returns {number} damage per instalment
   */
  _contactHurtAt(mob) {
    const c = mob.cell;
    const col = this._colOf(c.f, c.ci, c.cj);
    if (col < 0) return 0;
    const reach = mob.radius + CONTACT_TOUCH;
    const k0 = Math.floor(c.ck);
    // Height in cells. Two traps here, both of which fail *quietly* rather than
    // loudly, which is why they are written down:
    //
    // `height` lives on the spec, not on the mob record — `mob.height` is
    // undefined and would have collapsed to a default, testing the same one
    // layer for a bear and for a caterpillar.
    //
    // And it is `sizeJitter`, not `scale`. `scale` is
    // `spec.height / modelHeight * sizeJitter` — a model-units-to-cells
    // conversion — so multiplying the spec height by it again divides the
    // answer by the rig's own rest height and collapses every animal to about
    // half a layer. The individual variation is the jitter; the growth from
    // kills is `grown`.
    const bodyH = (mob.spec.height ?? 1) * (mob.sizeJitter ?? 1) * (mob.grown ?? 1);
    const k1 = Math.floor(c.ck + Math.max(0.5, bodyH));
    let worst = 0;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        // Gap to the nearest *edge* of that column, in cells. Zero for the
        // column the body is standing in; for a neighbour it is however far
        // the body is from the shared boundary. Measuring to the column's
        // centre instead would let an animal stand half inside a cactus
        // unharmed, since a cactus fills its column rather than sitting at a
        // point in it.
        const fi = c.ci - Math.floor(c.ci);
        const fj = c.cj - Math.floor(c.cj);
        const dx = di === 0 ? 0 : (di > 0 ? 1 - fi : fi);
        const dy = dj === 0 ? 0 : (dj > 0 ? 1 - fj : fj);
        if (Math.hypot(dx, dy) > reach) continue;
        const nc = stepColumn(col, di, dj);
        for (let k = k0; k <= k1; k++) {
          const hurt = CONTACT_HURT[this.planet.at(nc, k)];
          if (hurt > worst) worst = hurt;
        }
      }
    }
    return worst;
  }

  /**
   * Damage with nobody behind it — a fall, or lava.
   *
   * Deliberately not hurt(). Every line of that function is about the thing
   * that swung: which way to be shoved, whether to bolt or to come back
   * swinging, whose face to remember. There is no attacker here, and routing a
   * fall through it would have an animal sprint away from the ground it landed
   * on, in a direction picked from a position that means nothing.
   *
   * @returns {boolean} true if this killed it, so the caller stops touching it
   */
  _damage(mob, amount) {
    // Lava, a fall, a cactus, a mined-out floor. The world cannot kill him
    // either — "we can and must never catch it" is not only about running, and
    // a figure that burns to death on the ridge you were watching is caught.
    // Returning false and not true: true means "this body is gone", and every
    // caller uses it to `continue` out of the frame.
    if (mob.spec.phantom) return false;
    if (mob.dying > 0 || mob.health <= 0) return true;
    mob.health -= amount;
    mob.hurtT = 0.25;
    if (this.onSound) this.onSound(mob.health <= 0 ? 'death' : 'hurt', mob);
    if (mob.health <= 0) {
      // Nothing drops, for the same reason predation leaves nothing: a body the
      // player did not put down is not a payout. Every caller of this is the
      // world killing something — a fall, lava, a cactus — and animals walk into
      // all three on their own all day. Spilling the full table here made the
      // ground quietly fill with hide and meat nobody hunted for, and it read as
      // a kill being credited to whatever happened to be chasing at the time: a
      // deer bolting from a tiger into a cactus died with its drops on the floor,
      // which looks exactly like the tiger killing it and paying out.
      //
      // It also closes the cheaper version of the same exploit — shoving animals
      // off a ledge, or mining the block under one, was a way to farm meat
      // without ever winning a fight. `hurt()` is the path with a player behind
      // it, and that one still pays.
      this._die(mob, []);
      return true;
    }
    return false;
  }

  /**
   * Kill a mob: spill its drops, then either play the death clip or remove it
   * at once. `drops` can be overridden — a calf leaves nothing behind, and so
   * does anything the world killed rather than the player.
   */
  _die(mob, drops = mob.spec.drops) {
    const dieClip = mob.spec.clips.die;
    // Killing the merchant costs you the merchant. The body is removed by one
    // of two paths below, so the wait is started here where both pass through.
    if (mob.spec.trader) this.merchantT = MERCHANT_COOLDOWN;
    // A predator that has been eating is worth more. Linear from one to LOOT_MAX
    // across the same growth range the body uses, so the ceiling on size is also
    // the ceiling on the payout — there is no way to farm one of these past
    // double, however long it lives.
    const boon = 1 + (LOOT_MAX - 1) * ((mob.grown - 1) / (GROW_MAX - 1));
    // ...and a bigger animal is worth more than a smaller one of the same
    // species or of any other. `baseHeight` and not the height it is drawn at,
    // because the growth a predator ate its way to is already priced into
    // `boon` above and multiplying by it twice would pay a grown tiger four
    // times over. A calf is covered by the caller passing an empty list.
    const bulk = lootBulk(mob.baseHeight ?? mob.spec.height);
    for (const [name, min, max, chance] of drops) {
      const id = itemIdOf(name);
      if (!id) continue;
      // Optional fourth element: the odds this line appears at all. Every other
      // entry in the table is a guarantee with a range, which is right for the
      // things an animal is MADE of — a bear always has a hide. It is wrong for
      // the things an animal is CARRYING, i.e. what it had just eaten, which is
      // either there or it is not. A 0-min range is not the same thing: it
      // rolls against boon and bulk, so `['fish', 0, 1]` on a grown bear rounds
      // 0.5 x 2.0 x 1.27 up and pays out nearly every time.
      if (chance !== undefined && Math.random() >= chance) continue;
      const count = Math.round((min + Math.floor(Math.random() * (max - min + 1))) * boon * bulk);
      // Lift the drop along the mob's own up, not world +Y. On a sphere those
      // only agree at the north pole; everywhere else `+0.3` in Y was a sideways
      // nudge, and at the equator it pushed loot straight into the hillside.
      if (count > 0) {
        this.drops.spawn(
          mob.pos.x + mob.up.x * 0.3,
          mob.pos.y + mob.up.y * 0.3,
          mob.pos.z + mob.up.z * 0.3,
          id, count,
        );
      }
    }
    if (this.onSound) this.onSound('death', mob);
    if (dieClip && mob.model.actions[dieClip]) {
      // Leave the body long enough to read as a death rather than a despawn.
      mob.health = 0;
      mob.dying = 1.1;
      mob.speedNow = 0;
      return;
    }
    const idx = this.list.indexOf(mob);
    if (idx >= 0) { this._release(mob); this.list.splice(idx, 1); }
  }

  update(dt, player, sky) {
    this.voxCooldown = Math.max(0, this.voxCooldown - dt);
    this._escapeBudget = ESCAPE_PER_FRAME;
    // Route searches left this frame, on exactly the same terms and for the
    // same reason as the escape budget above. See PATH_PER_FRAME.
    this._pathBudget = PATH_PER_FRAME;
    this.bellT = Math.max(0, this.bellT - dt);
    this.merchantT = Math.max(0, this.merchantT - dt);
    this._resolveHits(dt, player);
    this._tickBreeding(dt);

    // Is the sun up where the player is standing? On a planet this is local,
    // not global — the far side is in night at the same moment.
    this.daylight = sky ? sky.sunDir.dot(player.up) : 1;
    const night = this.daylight < 0.02;

    // The night stalk's two clocks, ticked once for the planet rather than once
    // per cat — see the note where they are declared. They are allowed to run in
    // daylight too, which costs nothing and means the first cat to become
    // eligible after dark takes its roll on that frame instead of waiting out a
    // period it spent asleep.
    this.prowlT -= dt;
    if (this.prowlRest > 0) this.prowlRest -= dt;

    // The planet's threat list, on the same terms and for the same reason: one
    // pass shared by every prey animal rather than one pass each. See _spook.
    this._threatT -= dt;
    if (this._threatT <= 0) { this._threatT = THREAT_PERIOD; this._buildThreats(); }
    for (let n = this._alarms.length - 1; n >= 0; n--) {
      if ((this._alarms[n].t -= dt) <= 0) this._alarms.splice(n, 1);
    }

    // Top up the population *around the player*, wherever the player now is.
    //
    // The search was already anchored to the player's column rather than the
    // world origin, so the "they all cluster near spawn" report is not a bad
    // anchor — it is a rate. Everything within DESPAWN_RADIUS is kept and
    // everything past it is released, so the herd genuinely does follow you;
    // it just refilled at one animal every six seconds against a walking pace
    // that empties the ring far quicker than that, and stopped refilling
    // altogether at 18 bodies because the gate counted husks and fish too.
    // What the player saw was the world-start herd, which populate() drops all
    // at once, and then progressively less of anything the further they went.
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = SPAWN_PERIOD;
      const playerCol = this._colOf(player.cell.f, player.cell.ci, player.cell.cj);
      const have = this._census();
      // Night budgets. The daytime numbers stay the source of truth and this
      // scales them, so raising a population is still a one-line change in one
      // place. Fish keep theirs: they are under the surface, a player only
      // meets them by going looking, and thinning a shoal nobody can see costs
      // the night nothing and costs a swim its point.
      const wildCap = night ? Math.round(MAX_WILDLIFE * NIGHT_WILDLIFE) : MAX_WILDLIFE;
      const airCap = night ? Math.round(MAX_FLYING * NIGHT_WILDLIFE) : MAX_FLYING;
      let wild = have.land;
      for (let n = 0; n < SPAWN_PER_TICK && wild < wildCap; n++) {
        const spot = this._findSpawnColumn(playerCol, player.position);
        if (!spot) break;      // no ground going spare this tick; try the next
        if (this._spawnWild(spot.col, spot.k)) wild++;
      }
      // Fish come from the water, not the shore, so they get their own search —
      // and their own budget, which is the part that was missing. Placed after
      // the land pass but no longer *behind* it: nothing above can spend a slot
      // out of MAX_AQUATIC, so the order stopped mattering the moment the
      // budgets were split. In shoals, and up to FISH_PER_TICK a tick, because
      // one fish every other tick could not fill eighteen slots inside the
      // time a player spends near any one body of water.
      let wet = have.water;
      for (let n = 0; n < 2 && wet < MAX_AQUATIC; n++) {
        const room = Math.min(FISH_PER_TICK - (wet - have.water), MAX_AQUATIC - wet);
        const got = this._spawnShoal(playerCol, player.position, room);
        if (!got) break;       // no water in reach this tick
        wet += got;
      }
      // And the fliers, on the same terms.
      let air = have.air;
      for (let n = 0; n < 2 && air < airCap; n++) {
        const room = Math.min(FLIER_PER_TICK - (air - have.air), airCap - air);
        const got = this._spawnDrift(playerCol, player.position, room);
        if (!got) break;
        air += got;
      }

      // ...and the other half of the night budget: what is already alive when
      // the sun goes down. Stopping the top-up alone would only thin the herd
      // for a player who keeps walking, since the count falls by animals being
      // left behind — someone who camps in one spot would watch the same
      // daytime meadow graze around them all night. This retires the surplus
      // instead, a couple at a time and only well out of sight.
      // Two arguments, because there are two budgets. Adding them at the call
      // site is the exact bug `_bedDown` says in its own comment was removed —
      // the signature was widened and this line was not, so the parameter list
      // read (player, landSurplus) with `airSurplus` undefined, `air` came out
      // 0, and every flier over the night budget was paid for by retiring land
      // animals. A signed sum also let an empty sky raise the land ceiling.
      if (night) this._bedDown(player, wild - wildCap, air - airCap);
      // Husks come out of the dark: after sunset in the open, and at any hour
      // underground. That is what makes a cave dangerous rather than just dim,
      // and what makes a torch worth carrying.
      // Surface and cave husks draw on separate budgets. Sharing one was a slow
      // poison: cave husks spawn at any hour and, sealed in a cavern under your
      // feet, count as "nearby" on straight-line distance while never being
      // able to reach you. After twenty minutes of play six of the seven slots
      // were held by husks in a dungeon the player had never entered, so night
      // on the surface spawned nothing and a player could stand in the open
      // until dawn untouched. Measured: seven hostiles alive, six aggroed, none
      // of them within thirty seconds' walk of anything.
      // A brand-new world holds them off for a few minutes. The planet keeps
      // the player's own clock now, so starting a new game after dark is
      // ordinary rather than exceptional — and measured, that opening was
      // unplayable: first hit two seconds in, dead inside a minute, seven
      // hostiles already up, against someone with an empty inventory who has
      // not yet found the mouse. Night is meant to be the pressure that makes
      // torches and walls matter, not a loading screen you die on.
      const surfaceCap = this.savage ? MAX_HOSTILE_SAVAGE : MAX_HOSTILE_SURFACE;
      if (night && !this.spawnGrace && this._countHostile(false) < surfaceCap) {
        const spot = this._findSpawnColumn(playerCol, player.position);
        if (spot) { const m = this.spawn('husk', spot.col, spot.k); if (m) m.fromCave = false; }
      }
      if (!this.spawnGrace && this._countHostile(true) < MAX_HOSTILE_CAVE) {
        const spot = this._findDarkColumn(playerCol, player.position);
        if (spot) { const m = this.spawn('husk', spot.col, spot.k); if (m) m.fromCave = true; }
      }
      // The monsters. Their own clock, their own cap, and no night condition:
      // these are the things that do not care about the sun.
      //
      // A roll this low is what "rare" means here. At MONSTER_CHANCE per spawn
      // tick a monster is a thing you meet on an expedition rather than a thing
      // that turns up outside the door, and the cap keeps two from becoming
      // four while you are dealing with the first. `spawnGrace` covers them for
      // the same reason it covers husks — a new world's opening minutes are not
      // where this belongs.
      if (!this.spawnGrace && this._countMonsters() < MAX_MONSTERS
          && Math.random() < MONSTER_CHANCE) {
        const spot = this._findSpawnColumn(playerCol, player.position);
        if (spot) this._spawnMonster(spot.col, spot.k);
      }
      // The stalker. One at a time, on his own clock, and rolled against a
      // chance that is an order of magnitude lower at noon than at midnight —
      // the husk's shape (a night term) laid over the monsters' (a roll against
      // a cap), because he wants both halves and neither budget.
      //
      // Not gated on `spawnGrace`. That exists so a new world's first minutes
      // are not a fight, and this is not one: nothing here can hurt the player,
      // so there is nothing for the grace to protect them from. `_nearHome` in
      // the placement keeps him out of the opening clearing, which is the part
      // of the grace that is actually about him.
      //
      // The MAX_MOBS guard is a slot he must never be the one to take. He is
      // the last thing rolled for, and two under the ceiling rather than one so
      // that a sighting can never be the reason the *next* husk fails to spawn.
      if (this.stalkerRest > 0) this.stalkerRest -= SPAWN_PERIOD;
      if (this.stalkerRest <= 0 && !this._countStalkers()
          && this.list.length < MAX_MOBS - 2
          && Math.random() < (night ? STALKER_NIGHT_CHANCE : STALKER_DAY_CHANCE)) {
        const spot = this._findStalkerSpot(playerCol, player.position);
        const seen = spot ? this.spawn('stalker', spot.col, spot.k) : null;
        if (seen) {
          seen.hauntT = STALKER_LIFE;
          // Facing you from the first frame. `_haunt` would turn him round over
          // the next second anyway, and a figure caught mid-turn on the frame
          // he is noticed reads as one that walked there.
          _rel.copy(player.position).sub(seen.pos);
          const fr0 = seen.frame;
          seen.heading = Math.atan2(
            _rel.x * fr0.eb[0] + _rel.y * fr0.eb[1] + _rel.z * fr0.eb[2],
            _rel.x * fr0.ea[0] + _rel.y * fr0.ea[1] + _rel.z * fr0.ea[2],
          );
          seen.want = seen.heading;
          seen.placed = false;      // adopt that heading outright, do not slerp
          this._animate(seen, 0);
          this.stalkerRest = STALKER_REST;
        }
      }
      // The merchant. Same surface search as the wildlife — it has to arrive on
      // ground it can walk on — but gated on its own clock rather than on the
      // headcount, so it is never crowded out by a full paddock.
      // Daylight only. There was no time condition here at all, so a trader was
      // as likely to come out of the dark as a husk was — which reads as one
      // more thing the night spawns, and undercuts both. He is the one mob on
      // the planet that will talk to you; he keeps daytime hours.
      if (!night && this.merchantT <= 0 && !this.merchant() && Math.random() < MERCHANT_CHANCE) {
        const spot = this._findMerchantColumn(playerCol, player.position);
        const mob = spot ? this.spawn('merchant', spot.col, spot.k) : null;
        if (mob) this.onMerchant?.(mob);
      }
    }

    for (let n = this.list.length - 1; n >= 0; n--) {
      const mob = this.list[n];
      const c = mob.cell, spec = mob.spec, fr = mob.frame;

      const dist = mob.pos.distanceTo(player.position);
      if (dist > DESPAWN_RADIUS) {
        if (spec.trader) this._retireMerchant(mob, n);
        else { this._release(mob); this.list.splice(n, 1); }
        continue;
      }

      // The stalker, before anything else touches him.
      //
      // First, because every line below this is a thing he must not be seen to
      // do. Getting this in the right place is the whole feel of the thing: he
      // must never be watched walking off, never fade, never turn away. The
      // frame the player stops looking is the frame he stops existing, and the
      // next look finds an empty ridge.
      //
      // Collected rather than spliced, and `continue` rather than falling
      // through, so nothing animates him on his last frame — see `_vanished`.
      if (spec.phantom) {
        if (this._unobserved(mob, dist)) { this._vanished.push(mob); continue; }
      }

      // A merchant has somewhere else to be. Letting one linger indefinitely
      // would turn a chance meeting into a shop you could pin to a landmark.
      if (spec.trader) {
        mob.life -= dt;
        if (mob.life <= 0) { this._retireMerchant(mob, n); continue; }
      }

      mob.hurtT = Math.max(0, mob.hurtT - dt);
      // The predation clocks, here rather than inside _stalk — see the note
      // there. Every frame this body exists, whatever it is doing.
      mob.biteT = Math.max(0, mob.biteT - dt);
      mob.hungerT = Math.max(0, mob.hungerT - dt);
      mob.lungeT = Math.max(0, mob.lungeT - dt);
      mob.slideT = Math.max(0, mob.slideT - dt);
      mob.stateT -= dt;
      mob.idleT += dt;
      mob.swingT = Math.max(0, mob.swingT - dt);

      // A husk killed by the sun plays out its death before it is removed.
      if (mob.dying > 0) {
        mob.dying -= dt;
        mob.speedNow = 0;
        this._animate(mob, dt);
        if (mob.dying <= 0) { this._release(mob); this.list.splice(n, 1); }
        continue;
      }

      // --- daylight burns the undead ---
      if (spec.burns && this.daylight > 0.06 && this._skyLit(mob)) {
        mob.burnT += dt;
        if (mob.burnT > 0.35 && this.onBurn) this.onBurn(mob);
        if (mob.burnT > BURN_SECONDS) {
          // Note the missing second argument: passing `null` here made `drops`
          // null rather than defaulting, the for-of threw, and the frame's
          // try/catch swallowed it — so husks burned for ninety seconds and
          // never died.
          this._die(mob);
          continue;
        }
      } else if (mob.burnT > 0) {
        mob.burnT = Math.max(0, mob.burnT - dt * 2);
      }

      // idle vocalisation on the animal's own jittered clock. The clock always
      // resets, whether or not the call was actually allowed through, so a mob
      // that was out of earshot doesn't fire the instant you walk up to it.
      mob.voxT -= dt;
      if (mob.voxT <= 0) {
        // A bell you hear once every fourteen seconds is not something you can
        // navigate by; the merchant keeps a much tighter clock than the herd.
        mob.voxT = spec.trader
          ? BELL_MIN + Math.random() * (BELL_MAX - BELL_MIN)
          : VOX_MIN + Math.random() * (VOX_MAX - VOX_MIN);
        this._tryVocalise(mob, dist, player);
      }

      // A hostile only decides *where it wants to go* differently; everything
      // below — steering, the footprint test, hopping a step, the seam handling
      // — is the same hard-won movement code the animals use.
      // `predator` covers both the tiger that comes for you unasked and the fox
      // that only does so once you have hit it; `hostile` is the husk alone,
      // because that flag also drives the night spawn budgets and main.js's
      // grace-period wipe. Conflating them either starves the husk cap or
      // deletes every big cat on the planet at first light.
      // The night stalk runs *before* the chase, not instead of it, and it is
      // asked every frame rather than only when nothing else is happening. It
      // has two jobs: to decide when a hungry big cat commits to you, and to
      // decide when it lets go again — and the letting-go half has to keep
      // running while the cat is mid-chase, or sunrise never reaches it.
      // Committing hands _hunt a target and returns false, so the chase starts
      // on the same frame through the one code path that knows how to chase.
      // The stalker's own steering, ahead of all of it and exclusive of all of
      // it. He carries none of the flags the four below are gated on — no
      // `stalks`, no `hostile`/`monster`/`predator`, no `preyOn`, no `love` —
      // so each of them would refuse him on its own; `haunting` is not there to
      // stop them running, it is there to stop the *wander* underneath them.
      const haunting = spec.phantom && this._haunt(mob, dt, dist, player, fr);
      const prowling = !haunting && this._prowl(mob, dt, dist, player, fr);
      const hunting = !prowling && !haunting
        && (spec.hostile || spec.monster || spec.predator)
        && this._hunt(mob, dt, dist, player, fr);
      // Then the herd. Hunting the player wins over hunting dinner: something
      // that has decided on you should not wander off after a rabbit mid-fight.
      const stalking = !hunting && !prowling && this._stalk(mob, dt);
      // Courtship steers the same way hunting does, and for the same reason:
      // wandering will not reliably bring two animals together inside the love
      // window. Fleeing still wins — a spooked animal has other priorities.
      const courting = !hunting && !prowling && !stalking && this._court(mob, fr);
      // And the prey's side of the ecology. Last of the five, so it overrides
      // the courtship above it — "fleeing still wins", the same rule that
      // comment already states — and gated out of the three that mean this
      // animal is itself the one doing the hunting: a tiger mid-chase is not
      // frightened of the lion at the far end of the valley, and a hungry fox
      // that abandoned a rabbit because a bear walked past would be the
      // stampede this is trying not to cause.
      const spooked = !hunting && !prowling && !stalking && !haunting
        && this._spook(mob, dt);
      if (!prowling) mob.creep = false;

      // --- behaviour: pick a *desired* heading, never assign the real one ---
      const wasFleeing = mob.state === 'flee';
      if (!hunting && !prowling && !stalking && !courting && !haunting && !spooked
        && mob.stateT <= 0) {
        if (wasFleeing) {
          mob.state = 'idle';
          mob.stateT = 1 + Math.random() * 2;
        } else if (mob.state === 'walk') {
          // Nothing grazes in water. There is no grass under it, and the eat
          // clip on a body standing in a lake is the whole of "I saw some land
          // animals still going to water doing eating animations" — measured at
          // 18.4% of all grazing time before this line, because the fordable
          // shallows are exactly where a wandering animal spends its time near
          // a shore and `wading` is false in all of it.
          //
          // The draw is taken either way so that adding this test does not
          // shift every later Math.random() in the frame, which would make the
          // before and after of an unrelated measurement disagree for no
          // reason. Falls through to 'idle', which is a believable thing to be
          // doing ankle-deep in a stream.
          const wantsGraze = Math.random() < spec.grazeChance;
          mob.state = (wantsGraze && !mob.legsWet) ? 'graze' : 'idle';
          mob.stateT = spec.idleMin + Math.random() * (spec.idleMax - spec.idleMin);
        } else {
          mob.state = 'walk';
          mob.stateT = 2 + Math.random() * 4;
          // steer by a bounded turn from the current heading rather than
          // jumping to an arbitrary one — that snap read as a teleport
          mob.want = wrapAngle(mob.heading + (Math.random() - 0.5) * 2.6);
          // ...unless it belongs on a shoreline and has drifted off one. The
          // pull goes here, on the frame a new heading is chosen, rather than
          // as a steady force every frame: a crab that is nudged waterward
          // continuously walks a dead-straight line into the sea, which is a
          // different kind of wrong from wandering into the dunes. Choosing
          // the *direction of the next wander* keeps the crab meandering while
          // its meander stays inside the surf.
          if (spec.shore) {
            const toWater = this._shoreBearing(mob);
            if (toWater !== null) mob.want = toWater;
          }
        }
      }
      // Deliberately not gated on `stalking`: a fox stays a fox, and one that
      // ignored an approaching player because it had its eye on a rabbit would
      // be less believable than one that abandons the chase and bolts.
      if (!hunting && !wasFleeing && dist < 3.4 * spec.skittish && spec.skittish > 0.5) {
        mob.state = 'flee';
        mob.stateT = 1.6 + Math.random();
        // ...but not over the top of a deflection that is still live. Same rule
        // as _boltAway's, and the same reason: an animal pinned against water by
        // an approaching player would otherwise be re-aimed into it every time
        // this re-triggers, and the way round it had found is thrown away.
        if (mob.slideT <= 0) {
          _rel.copy(mob.pos).sub(player.position);
          const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
          const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
          mob.want = Math.atan2(rb, ra);
        }
      }

      // Nothing re-tests a state once it is set — `stateT` simply runs out — so
      // refusing to *enter* graze in water is only half of it. An animal that
      // started grazing on a dry bank and then wandered, was chased or was
      // flooded into the shallows would otherwise keep the eat clip running for
      // the rest of its idle timer, which is up to spec.idleMax seconds of
      // exactly the thing that was reported. Kept out of the block above
      // because that one only runs when the timer has expired.
      if (mob.state === 'graze' && mob.legsWet) mob.state = 'idle';

      // --- and a land animal in the water overrides all of it ---------------
      //
      // "If a land animal falls in water they should try their best to get
      // out." Last on purpose, so it beats the wander, the flee and the shore
      // pull alike: a deer in a river has exactly one problem and it is not
      // whichever of those it was doing a second ago.
      //
      // `mob.wading` is set at the bottom of this loop, from the block the body
      // is actually in, so it is one frame old here. That is the same lag every
      // other decision in this section runs on — they all read `mob.pos` — and
      // a sixtieth of a second of swimming in the wrong direction is not
      // something anyone can see.
      if (mob.wading) {
        mob.swimT -= dt;
        if (mob.swimT <= 0) {
          mob.swimT = SWIM_PERIOD;
          const wcol = this._colOf(c.f, c.ci, c.cj);
          mob.swimWant = this._landBearing(mob, wcol);
          if (mob.swimWant !== null) { mob.swimFail = 0; mob.swimAlong = null; } else {
            // No bank it may climb. After SWIM_GIVE_UP of those in a row, stop
            // swimming at the one it cannot climb and follow it instead.
            mob.swimFail++;
            if (mob.swimFail >= SWIM_GIVE_UP) {
              // Commit to a side once, here, and keep it for as long as this
              // body is trapped — see _shoreTangent.
              if (!mob.slideDir) mob.slideDir = Math.random() < 0.5 ? -1 : 1;
              mob.swimAlong = this._shoreTangent(mob, wcol);
            }
          }
        }
        // Three answers, not two.
        //
        // A bank it can climb: swim at it. A bank it cannot: swim ALONG it —
        // `swimAlong` — which stops the body pressing itself into a cliff for
        // as long as the player is there to watch, and is the only way it will
        // ever reach a low stretch further round a lake than it can see from
        // here. And no bank at all within SWIM_LOOK columns: the middle of an
        // ocean, where it keeps swimming the way it was already going rather
        // than treading water or drowning. There is no drowning clock for mobs
        // and this is not the place to add one — it would fire out at sea where
        // nobody can see it and quietly eat the wildlife budget. It floats, it
        // keeps looking, and it either finds a shore or the despawn ring
        // collects it when the player walks away.
        //
        // Re-examined against "I saw a cow walking underwater" and still stands,
        // because that was not a body in the sea, it was a body that had crept
        // along the bed of a lake one equal-cost step at a time — 3.11% of
        // cow-frames fully submerged with the body grounded, worst stint 28.0s,
        // measured over five minutes on the real planet. Fixing the creep (see
        // the centre-sample test in _walkStep) took every non-amphibious land
        // species to 0.00% submerged over the same five minutes, so there is
        // nothing left for a drowning clock to be the answer to. The only
        // bodies the measurement still finds under the surface are the
        // amphibians, swimming.
        if (mob.swimWant !== null) mob.want = mob.swimWant;
        else if (mob.swimAlong !== null) mob.want = mob.swimAlong;
        mob.state = 'walk';
        mob.stateT = Math.max(mob.stateT, 0.5);
      }

      // --- and last of all, a body that has been getting nowhere ------------
      //
      // After the swim override rather than before it, and after every other
      // decision above for the same reason: this file already knows how to
      // steer a deer out of a river, and the watchdog exists for the case where
      // all of that has visibly failed. It only ever overrides a heading it has
      // already watched not work for three seconds. See _unstick.
      const escape = this._unstick(mob, dt, dist, fr);
      if (escape !== null) {
        mob.want = escape;
        mob.state = 'walk';
        mob.stateT = Math.max(mob.stateT, 0.5);
      }

      const fleeing = mob.state === 'flee';
      const chasing = mob.state === 'chase';
      const moving = mob.state === 'walk' || fleeing || chasing;
      // The three gaits, all built out of the one wander pace. `spec.speed` is
      // the amble and nothing moves at it except an animal with nowhere to be;
      // a chase and a bolt are bursts on top of it. See the speed ladder.
      //
      // Chase used to be the bare wander — 'walk' and 'chase' were the same
      // speed and differed only in the turn rate below, which is why the night
      // stalk needed a multiplier of its own to look like anything: with one
      // speed for every state, a creep built out of states was indistinguishable
      // from a wander. Now there are three speeds and PROWL_SPEED is simply the
      // fourth, still a fraction rather than a multiple.
      // Swimming for the bank is its own gait and comes first, ahead of the
      // flee it was very likely also in: an animal in water it did not choose
      // to be in is neither ambling nor bolting, and a bolt's turn rate would
      // have it overshoot the one gap in the bank anyway.
      // ...and a body that has given up on getting out drops to SWIM_CIRCLE.
      // A determined paddle is what a swimmer heading for a bank looks like; a
      // swimmer that has been round this pool twice is not still determined,
      // and holding SWIM_SPEED there is the difference between an animal that
      // has settled and one that is visibly still trying to leave.
      const swimPace = (mob.swimWant === null && mob.swimAlong !== null)
        ? SWIM_CIRCLE : SWIM_SPEED;
      // A hunt is the one chase whose pace is not the ladder's — see
      // PREY_CLOSE. `prey` alone is not enough to tell one apart: a courting
      // animal also chases (see _court), and a hunter that has been hit drops
      // its meal for the player without necessarily clearing `prey` on the
      // same frame, so both are excluded rather than assumed.
      const onPrey = chasing && !!mob.prey && mob.love <= 0 && mob.target !== 'player';
      const targetSpeed = moving
        ? spec.speed * (mob.wading ? swimPace
          : fleeing ? FLEE_SPEED
          : mob.creep ? PROWL_SPEED
          : onPrey ? this._huntPace(mob)
          : chasing ? CHASE_SPEED : 1) : 0;

      // What the body is standing in, read once for everything that wants it:
      // the reference layer just below, the buoyancy, the swim-for-shore
      // steering, the fall-damage cancel and the lava toll.
      //
      // It sits above `here` rather than beside the buoyancy where it was
      // written, because `here` now depends on it — a floating body's reference
      // is the water holding it up, not the bed twenty layers down. Nothing
      // between the old position and this one touches c.ci, c.cj or c.ck, so
      // the readings are the same ones; they are simply taken before they are
      // needed rather than after. It also quietly settles the caveat on the
      // turn check below, which used to be comparing costs computed under the
      // *previous* frame's water flags.
      //
      // `liquidAt` is true of lava as well as water, and that is exactly the
      // distinction the swimming rules care about — an animal that fell in a
      // river should strike out for the bank, an animal that fell in lava has a
      // different problem and one second to solve it.
      const bodyCol = this._colOf(c.f, c.ci, c.cj);
      const feetK = Math.floor(c.ck);
      const inLiquid = this.planet.liquidAt(bodyCol, feetK);
      const inLava = inLiquid && this.planet.at(bodyCol, feetK) === ID.lava;
      const inWater = inLiquid && !inLava;
      const swimming = (spec.aquatic || spec.amphibious) && inLiquid;
      mob.swimming = swimming;
      /**
       * And a land animal that has ended up in the water anyway — knocked in,
       * chased in, or standing where someone dug a channel.
       *
       * It floats and it swims, rather than sinking to the bed and walking it,
       * which is what happened before: gravity applied, the body settled on the
       * bottom, and then _footprintCost — which treats water as a wall for
       * anything without `amphibious` — refused every direction it could go, so
       * it stood on the lake floor until the player left. No drowning, no
       * escape, no animation but the idle. A condition of the body rather than
       * a species flag, because it is not a way of life, it is an accident.
       */
      //
      // ...but only once it is out of its depth. `wading` used to mean "in
      // contact with water", and everything hanging off it — the float to the
      // surface, the paddle, the swim for the bank that overrides every other
      // decision this body has made — then fired in an inch of it. A husk that
      // put a foot in a stream stopped chasing and struck out for the shore.
      // Standing in shallow water is not an accident that has befallen an
      // animal; it is walking, with water round its legs. See WADE_STAND.
      const wading = !swimming && !spec.flies && inWater
        && !this._fordable(bodyCol, this._groundK(bodyCol, feetK, !!spec.climbs),
          this._wadeDepth(mob));
      mob.wading = wading;
      // Water round the legs at ANY depth, which `wading` on the line above
      // deliberately is not. Read by the settled behaviours — see legsWet where
      // it is declared, and the graze test in the behaviour block.
      mob.legsWet = inWater && !swimming && !spec.flies;
      // A bee was a walker with a hop, which is a bee doing an impression of a
      // rabbit. Flight is the same shape as the fish's buoyancy below: hold a
      // height rather than fall, and never be grounded.
      //
      // It used to steer by the walking rules too — this comment said so, and
      // said that was what kept a flier over the ground it belongs to instead of
      // out to sea. It was wrong on both counts by the time it was read: water
      // had already been exempted for fliers a few lines into _colCost (nothing
      // ever flew over a lake before that), and the rest of the walking rules
      // were not keeping a flier anywhere, they were refusing every heading
      // equally and so refusing nothing. A flier is collided as a body in the
      // air now. See the flier branch in _colCost.
      // Local only. `mob.swimming` and `mob.wading` are published on the body
      // because _footprintCost asks about them from outside this loop; nothing
      // ever asked about flight, so a `mob.flying` written every frame for
      // every body was a flag with no reader.
      const flying = !!spec.flies;

      // The layer the feet are standing on, hoisted above the steering because
      // the turn is checked against terrain now and wants the same reference
      // layer the move does.
      //
      // The block directly under the feet — NOT the highest ground under the
      // footprint. _groundUnder takes the max, which is right for deciding how
      // high to stand (it keeps the body out of a step's riser) but wrong for
      // deciding whether a move is legal: the moment the animal's nose reached
      // over a step it counted as already standing on it, so the step stopped
      // reading as a rise and the hop never fired.
      //
      // ...and for a body that is *floating*, the block under its feet is not
      // what is holding it up. It hangs WADE_RIDE into the top water layer, so
      // "the layer below the feet" is a layer of water, and every rule measured
      // off it — the ground scan in _footprintCost, the floor scan below — was
      // being asked about the wrong height by exactly one. The scan then could
      // not even *see* a bank standing a block proud of the water: _groundK
      // starts at `here + 1`, which was the water surface, so it walked past
      // the bank block and reported the bed. A tiger knocked into a lake could
      // therefore only ever climb out where the shore happened to be flush with
      // the water line, and slid along everything else at swimming speed with
      // the run clip playing. The water surface is the thing carrying the body,
      // so the water surface is its ground.
      //
      // Only while it is genuinely riding at the surface, which is what the
      // half-block test is for: a body that has been driven under — a knock, or
      // still sinking — is not stepping out onto anything, and reading its
      // reference off a surface a few layers above it would let it. Fish are
      // excluded outright; `aquatic` has its own branch in _footprintCost and
      // never climbs out of anything.
      // ...and it is `_refLayer` rather than the expression written out here,
      // because `_nudge` needs the same number and had a different one. Both
      // flags it reads were written a few lines above, so this is the same
      // reading it always was.
      const here = this._refLayer(mob);

      // --- steering: limited turn rate, smooth acceleration -----------------
      //
      // The turn is checked against the terrain, and it did not used to be.
      // A footprint is oriented, so rotating sweeps it: a body with 1.47 of
      // half-length can swing its own length into a block it could never have
      // walked into, and stand there with its snout inside the wall. That is
      // also how the tree-climbing escalator got in — turning to face a trunk
      // was what put a sample in the trunk's column, see _groundUnder — and
      // although the floor scan no longer takes the bait, the overlap the turn
      // creates was always real and is exactly the sort of state the next
      // change to this code would trip over.
      //
      // The rule is the one the move already uses, applied to rotation instead
      // of translation: a turn is refused only if it makes the overlap
      // *strictly* worse. Equal is allowed, unlike the move, and the difference
      // is load-bearing — a body walking along a wall keeps a sample in the
      // stone for as long as it is beside it, and "must improve" would pin its
      // nose facing wherever it happened to be pointing when it arrived.
      // Rotation cannot creep the way translation can, which is what "no worse"
      // permitted there: the limiter only ever turns toward `want` and stops on
      // it, so there is no deeper for a body to drift to one frame at a time.
      //
      // Refusing turns is the obvious way to lock an animal up, so it is off
      // whenever the body could not translate either — `mob.stuck`, set by
      // _walkStep. Being unable to move is exactly when rotation is the only
      // move left: the wall slide and the doorway probe both work by changing
      // the heading, and gating those would put a husk back to standing at the
      // wall it cannot get round, which an open door was supposed to have
      // fixed. Nothing else needs an escape valve, because holding a heading
      // does not stop a body: it keeps walking the way it was already going,
      // the footprint moves with it, and the turn goes through a frame or two
      // later once the wall has run out. No stutter either — the heading only
      // ever moves toward `want`, never back, so a refused frame is a pause in
      // the rotation and never a reversal of it.
      const turn = spec.turn * (fleeing ? 1.6 : chasing ? 1.35 : 1) * dt;
      const dh = wrapAngle(mob.want - mob.heading);
      const turned = wrapAngle(mob.heading + clamp(dh, -turn, turn));
      // Two footprint tests, and only on the frames an animal is actually
      // turning and is not already stuck — most frames it is sitting on its
      // `want` and this costs nothing.
      //
      // The two tests are deliberately *both* taken here rather than one of
      // them being handed to _walkStep to save a test. They agree with each
      // other because they differ only in the heading, but they do not agree
      // with _walkStep: _footprintCost branches on mob.swimming and mob.wading,
      // and those are not rewritten until further down the frame. The
      // comparison is unaffected — whatever the flags say, they say it to both
      // sides — but a number measured under last frame's flags is not the
      // baseline _walkStep's own tests are measured against, and on the frame a
      // body enters or leaves water the two would disagree about whether water
      // is a wall.
      if (turned !== mob.heading) {
        if (mob.stuck) mob.heading = turned;
        else {
          const held = this._footprintCost(c.f, c.ci, c.cj, here, mob, mob.heading);
          const swept = this._footprintCost(c.f, c.ci, c.cj, here, mob, turned);
          if (swept <= held) mob.heading = turned;
        }
      }

      const kAcc = 1 - Math.exp(-spec.accel * dt);   // frame-rate independent
      mob.speedNow += (targetSpeed - mob.speedNow) * kAcc;
      if (mob.speedNow < 0.005) mob.speedNow = 0;

      // --- integrate in cell space ------------------------------------------
      const ch = Math.cos(mob.heading), sh = Math.sin(mob.heading);
      mob.vel.i = ch * mob.speedNow / fr.arcA;
      mob.vel.j = sh * mob.speedNow / fr.arcB;

      // Knockback rides on top of steering rather than replacing it, so a husk
      // is shoved back while still facing you and closes again the moment it
      // lands. Steering alone could never express this: horizontal velocity is
      // rebuilt from heading every frame, so a blow had nowhere to go and two
      // husks could stand inside your hitbox trading damage until one of you
      // fell over. This is the beat that makes a fight a fight.
      if (mob.knockT > 0) {
        const decay = mob.knockT / KNOCK_TIME;
        mob.vel.i += mob.knockA * decay / fr.arcA;
        mob.vel.j += mob.knockB * decay / fr.arcB;
        mob.knockT = Math.max(0, mob.knockT - dt);
      }

      // A fish is neutrally buoyant while it is in water, and drops like
      // anything else the moment it is not — so one flung onto the bank flaps
      // its way back down rather than hovering over the grass. Without this it
      // would sink and walk the lake bed, which is the one thing worse than
      // having no fish at all.
      // An amphibian swims by exactly the same rule, and only while it is
      // actually in the water — which is the difference between the two flags
      // in one line: a fish is buoyant wherever it is because it is never
      // anywhere else, a crab is buoyant only once it has walked in.
      //
      // (`swimming`, `wading`, `flying` and the readings behind them are taken
      // at the top of this body's turn now, because `here` is derived from
      // them. Nothing about them has changed but where they are read.)
      if (swimming) {
        // gentle rise and fall on its own clock, and it never leaves the water
        const ceilK = this._waterTop(bodyCol, feetK);
        const want = Math.sin(mob.idleT * 0.6 + mob.seed) * 0.45;
        mob.vel.k += (want - mob.vel.k) * Math.min(1, dt * 3);
        if (c.ck > ceilK - 0.6) mob.vel.k = Math.min(mob.vel.k, -0.2);
      } else if (wading) {
        // The opposite of the fish: it wants the *surface*, not a depth. Chase
        // the gap the way the flier does, so a body that went in hard sinks a
        // little and comes back up rather than popping to the top the instant
        // it touches the water. In water only a block deep the want lands
        // barely above the bed, so a puddle still reads as a puddle.
        const want = this._waterTop(bodyCol, feetK) + WADE_RIDE;
        const climb = clamp((want - c.ck) * 3.0, -1.4, 2.6);
        mob.vel.k += (climb - mob.vel.k) * Math.min(1, dt * 6);
      } else if (flying) {
        // Seek hover height above whatever is underneath, with a slow wander so
        // it never holds a dead-flat line. Chase the *gap* rather than setting a
        // velocity outright, so it eases in and out instead of snapping.
        const under = this._groundUnder(mob, c.f, c.ci, c.cj, Math.floor(c.ck + 0.02));
        const bob = Math.sin(mob.idleT * 1.9 + mob.seed) * 0.22
          + Math.sin(mob.idleT * 0.7 + mob.seed * 1.7) * 0.30;
        // ...and over whatever it is about to meet. The height seek reads the
        // ground under the body's *own* footprint, which is a report on where it
        // already is: a bird arrives inside the canopy and only then learns
        // there was a tree. Now that a flier's horizontal move is genuinely
        // refused by that canopy (see the flier branch in _footprintCost), a
        // seek with no look-ahead is a bird parked at the treeline. See
        // FLY_LOOK_NEAR.
        const ahead = this._flyAhead(mob, fr);
        const hold = under >= 0 ? under + spec.hover : c.ck;
        let want = (ahead >= 0 ? Math.max(hold, ahead + mob.tall + FLY_CLEAR) : hold) + bob;
        // ...but not into the roof. Under an overhang or in a cave mouth the
        // wall ahead is also a wall the body cannot climb over, and a lift it
        // can never satisfy is a body held against the ceiling for as long as it
        // faces that way: measured, one ghost spent 109 consecutive seconds
        // pinned in the rock before this clamp existed, against 1.2s for the
        // same species with it. Where there is no room, there is no lift, and
        // the veer in _walkStep is the way out — which is what it is for.
        if (want > c.ck) {
          const kTop = Math.ceil(want + mob.tall);
          for (let k = Math.floor(c.ck + mob.tall); k <= kTop; k++) {
            const id = this.planet.at(bodyCol, k);
            if (IS_SOLID[id] && !isPassable(id, this.planet.facingAt(bodyCol, k))) {
              want = Math.min(want, k - mob.tall);
              break;
            }
          }
        }
        const climb = Math.max(-2.2, Math.min(2.2, (want - c.ck) * 2.4));
        mob.vel.k += (climb - mob.vel.k) * Math.min(1, dt * 4);
      } else if (mob.climbTo !== null && spec.climbs
                 && this._climbHold(bodyCol, Math.floor(c.ck))) {
        // Shinning up beside the trunk. Same "chase the gap" shape the flier
        // uses, so it eases in and out instead of snapping to a speed.
        const rate = clamp((mob.climbTo - c.ck) * 2.4, -CLIMB_SPEED, CLIMB_SPEED);
        mob.vel.k += (rate - mob.vel.k) * Math.min(1, dt * 5);
        // Hold on with both hands — by position, not by persuasion.
        //
        // Damping the velocity was the first attempt and it is not enough: the
        // steering that sets it runs every frame, and a monkey that starts
        // fleeing while it is up a tree overpowers the damping, drifts out of
        // the column it was holding, loses its grip and falls. Measured at two
        // of six climbs ending in a two-damage landing — an animal hurting
        // itself doing the one thing this feature exists to let it do. Easing
        // the body back to the column it set out from cannot be outvoted.
        c.ci += (mob.climbCi - c.ci) * Math.min(1, dt * 8);
        c.cj += (mob.climbCj - c.cj) * Math.min(1, dt * 8);
        mob.vel.i *= 0.02;
        mob.vel.j *= 0.02;
        // A controlled descent is not a fall. Without this, coming down eight
        // layers under its own power landed as a seven-layer drop and hurt —
        // the animal would have climbed a tree and then injured itself getting
        // out of it, every time.
        mob.fallFrom = null;
        // A climb that is not getting anywhere is abandoned. Belt and braces
        // against an animal hanging in a tree for the rest of the session
        // because something above it turned out to be in the way — the failure
        // this replaced, which cost nothing to detect and everything to miss.
        if (Math.abs(c.ck - mob.climbLastK) > 0.05) {
          mob.climbLastK = c.ck;
          mob.climbStallT = 0;
        } else if ((mob.climbStallT += dt) > CLIMB_STALL) {
          mob.climbTo = null;
          mob.climbRestT = CLIMB_REST;
          mob.perchT = 0;
          mob.climbGrace = CLIMB_GRACE;
        }
        if (mob.climbTo !== null && Math.abs(mob.climbTo - c.ck) < 0.35) {
          if (mob.perchT > 0) {
            // Arrived at the top: sit for a while, then head back down.
            mob.perchT -= dt;
            if (mob.perchT <= 0) {
              // Scan from *below* the feet, and only accept an answer that is
              // actually below. Scanning from the feet layer itself returns
              // whatever the body is standing on, and for a monkey that has
              // drifted a column into the trunk that is the top of the trunk —
              // so the "descent" was a climb, it arrived with the perch already
              // spent, and it let go seven layers up. That is where the last of
              // the fall damage was coming from.
              const down = this._groundK(bodyCol, Math.floor(c.ck) - 1, false);
              mob.climbTo = (down >= 0 && down < c.ck) ? down : null;
              if (mob.climbTo === null) {
                mob.climbRestT = CLIMB_REST;
                mob.climbGrace = CLIMB_GRACE;
              }
            }
          } else {
            // Back on the ground. Let go and be an ordinary animal again.
            mob.climbTo = null;
            mob.climbRestT = CLIMB_REST;
          }
        }
      } else {
        // Nothing to hold — whatever it was doing, it is falling now.
        if (mob.climbTo !== null) {
          mob.climbTo = null;
          mob.climbRestT = CLIMB_REST;
          mob.climbGrace = CLIMB_GRACE;
        }
        mob.vel.k -= GRAVITY * dt;
      }

      // One step per frame, no substepping, and the footprint test below checks
      // the destination rather than sweeping the line to it — so the step has to
      // stay under a block or a fast body could straddle a wall. main.js clamps
      // dt at 0.1, and the quickest gait in the file is the bee's chase at 6.3
      // cells/s, which is 0.63 of a cell on the worst frame the engine allows.
      // That is the tightest margin here and it is the thing to check first if
      // any multiplier in the speed ladder is ever pushed past about 4.
      const ni = c.ci + mob.vel.i * dt;
      const nj = c.cj + mob.vel.j * dt;
      // Where it was, so the gait can be read off the ground it actually covers
      // rather than off what it meant to cover. Taken before the fork below and
      // compared after the clamps, i.e. across every way a body can be moved or
      // refused — and before the seam wrap, which is a change of coordinates
      // rather than a movement.
      const fromI = c.ci, fromJ = c.cj;

      // Cross-face-safe column lookups. The old code did cidx(c.f, floor(ci),
      // floor(cj)) with the indices merely clamped, so at a cube seam it probed
      // a column on the WRONG face; the ground snap below then teleported the
      // animal to that column's height.
      // (`here`, the layer under the feet, is now worked out above the steering
      // — the turn check needs it too.)

      // Walking, or being thrown. They are not the same move and this is the
      // fork between them.
      //
      // Every rule in the walking move is a *preference* — I will not step into
      // water, I will not step off a drop, I will not squeeze through a gap I
      // do not fit — and asking a struck animal for its preferences is the
      // whole of the second report: "I tried punching a deer next to a river
      // and it won't fall". Of course it will not. The river is a wall to a
      // deer, the wall was enforced on every move whatever caused it, and the
      // floor clamp below put the deer back on the bank on the same frame. The
      // knockback was not missing; it was asking permission, and being refused.
      //
      // So while it tumbles the body is not walking. The only thing that stops
      // it is rock: it does not veer, it does not hop, it does not consult the
      // ground, and it lands where it lands — over the edge, in the water, at
      // the bottom of the ravine — and pays for the fall like anything else.
      // The tumble ends the moment it is back on its feet with the shove spent.
      const tumbling = mob.knockT > 0 || (mob.tumbling && !mob.grounded);
      mob.tumbling = tumbling;
      if (tumbling) {
        this._tumble(mob, mob.vel.i * dt, mob.vel.j * dt);
        // A thrown body does not get its rotation policed either, for the same
        // reason it does not get the footprint test: it has stopped choosing.
        // Leaving the flag at whatever the last walking frame set would have a
        // struck animal's heading held by terrain it is no longer negotiating
        // with.
        mob.stuck = true;
      } else this._walkStep(mob, ni, nj, here, fr, player);

      const prevCk = c.ck;
      // A swimmer's rise and fall is checked against the terrain, and it was
      // not — see _swimBlocked. Only `aquatic` pays for this: a flier has open
      // sky above it and a wading animal is held at the water line by
      // buoyancy, so neither has ever had a way to climb into rock.
      if (spec.aquatic && mob.vel.k !== 0) {
        const nk = c.ck + mob.vel.k * dt;
        if (this._swimBlocked(mob, nk, c.ck)) mob.vel.k = 0;
        else c.ck = nk;
      } else c.ck += mob.vel.k * dt;
      const col = this._colOf(c.f, c.ci, c.cj);

      // Ceiling. There was none at all, so an animal under an overhang pushed
      // its head into the block above and nothing ever stopped it rising.
      if (mob.vel.k > 0) {
        const headK = Math.floor(c.ck + mob.tall);
        if (this.planet.solidAt(col, headK)) {
          c.ck = Math.min(c.ck, headK - mob.tall);
          mob.vel.k = 0;
        }
      }

      // Floor. The scan starts from where the animal *was*, not from a cell
      // above where it now is: starting high let it discover the block above
      // its head — a tree trunk, say — and "land" on top of it, then repeat
      // the next frame. That is what walked animals up trunks to the canopy,
      // a block per frame. The lift is also capped at MOB_MAX_RISE, so a
      // genuine step up still works but nothing can escalate — and both
      // branches below are capped now, which the swimming one was not.
      // `floor` is a real height now, not a layer index — see _groundUnder.
      //
      // `here + 1` rather than `floor(prevCk + 0.02)`, which is the same number
      // for everything that walks, flies or swims: `here` is that expression
      // minus one and nothing since has touched c.ck. It differs for exactly
      // one case, the one it is written for — a body floating at the water
      // line, whose reference layer is the surface holding it up. Starting the
      // scan a layer low is why a bank a block proud of the water was invisible
      // to the clamp as well as to the footprint test, so the pair of them are
      // now asking about the same ground.
      const floor = this._groundUnder(mob, c.f, c.ci, c.cj, here + 1);

      // Did the body come down *through* the surface during this frame? That is
      // unambiguously a landing rather than a step up, and it has to be allowed
      // whatever the height involved: the one-block cap below is there to stop
      // the escalator _groundUnder describes, and a body genuinely falling can
      // cross far more than a block in a frame. At the 0.1s frame main.js
      // allows, terminal velocity is two cells — so before this, an animal that
      // fell any real distance passed straight through the ground it should
      // have landed on and rode the c.ck < 1 bedrock clamp down to the mantle.
      // Nothing ever fell far enough for that to show until knockback started
      // pushing them off things.
      const crossed = prevCk >= floor;

      // A swimmer never snaps to the lake bed — that ground clamp is exactly
      // what would make a fish walk along the bottom.
      //
      // A *wading* animal is deliberately not in that company, though it is
      // just as buoyant. The clamp only ever acts on ground within about a
      // block of the body, and in open water the bed is nowhere near that, so
      // it does nothing and the buoyancy above holds the animal at the surface
      // exactly as it does for a fish. The moment the ground under it comes up
      // to meet it — the shallows, or the bank it has been swimming at — the
      // clamp lifts it out and calls it grounded, which is the whole of
      // climbing out of a river and needs no code of its own.
      if (swimming || flying) {
        // Never snap to the floor and never count as grounded — the same reason
        // a fish must not: the ground clamp is what would put it back on foot.
        // It still may not sink through anything solid.
        //
        // Bounded by the same MOB_MAX_RISE as the walking clamp below, and it
        // was not. This branch set the height outright, which made it the one
        // place left in the movement code where a body could be moved upward an
        // arbitrary distance in a single frame: a bee inside a structure a
        // player had just built round it, or a fish under ground that arrived
        // beneath it, was on top of the thing instantly. Lifting at a bounded
        // rate squeezes it out over a handful of frames instead, which is a
        // body working itself free rather than a teleport, and it cannot
        // escalate for the reason the cap exists at all — the lift per frame is
        // capped whatever the terrain says.
        //
        // A body that came down *through* the surface this frame is exempt,
        // exactly as it is below. That is a plunge being caught rather than a
        // rise, and the distance involved is whatever it just fell, which its
        // own speed has already bounded.
        //
        // Neither of the cases this branch exists for is touched. A fish rising
        // through deep water and a bee climbing to clear a tree both do it with
        // vel.k; the clamp only ever pushes a body up off ground it is already
        // below, and in open water or open air there is no such ground within
        // reach of the scan. The third case, a wading land animal being lifted
        // onto a bank, is deliberately not in this branch at all — see the note
        // above — so it still runs on the walking clamp and has always had the
        // cap. Nothing about it changes here; the two branches simply agree on
        // the number now.
        // `+ mob.belly` because a fish is drawn from its middle, not its feet:
        // holding the origin at the surface buries the bottom half of the body
        // in the bed. Zero for everything the pack authors from the feet, i.e.
        // for every land animal and every flier, so this branch is unchanged
        // for them — see `belly` in modelExtents.
        //
        // ...and the bed that holds a swimmer up is the one under its own
        // column, not the highest ground anywhere under its footprint.
        //
        // `floor` is a max over nine samples, which is right for a body that is
        // standing: a deer with two feet on a step is held up by the step. A
        // fish is standing on nothing, and in the shallows those nine samples
        // reach the bank. That is the shark-on-land report, entire. Measured on
        // a sloping pool: a shark swimming in one-deep water with its nose over
        // the shore read the *shore's* height, and this clamp put it at bank +
        // belly — out of the lake and onto the beach, in one frame, from a
        // position and a move that were both legal.
        //
        // What turned a moment of daylight into a walk inland is what happens
        // next. `_colCost`'s aquatic branch asks whether the layer holding the
        // body is liquid, and above the surface the answer is no *everywhere*,
        // including where it stands — so a body whose own column already costs
        // the maximum has no worse neighbour to be refused by, _walkStep's
        // equal-cost escape admits every heading, and the fish swims off across
        // the sand. Over a five-minute run, 12 of 18 swimmers ended on dry
        // ground, every one of them lifted out of one-deep shallows first.
        //
        // A fish's tail overhanging a rock is not something to be lifted onto;
        // that overlap is the horizontal collision's business, and `_swimBlocked`
        // and `_aquaticCost` already hold it.
        const bed = spec.aquatic ? this._groundOwn(mob, col, here + 1) : floor;
        const rest = bed + mob.belly;
        if (bed >= 0 && c.ck < rest) {
          c.ck = crossed ? rest : Math.min(rest, c.ck + MOB_MAX_RISE);
          mob.vel.k = Math.max(0, mob.vel.k);
        }
        mob.grounded = false;
      } else if (floor >= 0 && c.ck < floor && mob.vel.k <= 0
        && (crossed || floor - c.ck <= MOB_MAX_RISE
          // Hauling itself out. A body at the water line sits WADE_RIDE into
          // the top water layer, so a bank one block proud of the water is 1.75
          // above its feet — over MOB_MAX_RISE, and refused, which is why the
          // footprint test being fixed on its own would only have walked the
          // animal to the edge of ground the clamp then declined to put it on.
          //
          // Safe for the reason the cap exists: an escalator needs a *second*
          // step to climb, and there is not one. This only fires while the body
          // is in the water, the reach it allows is the same WADE_CLIMB the
          // footprint test already used to permit the move, and the frame after
          // it lands the body is standing on the bank and is not wading at all.
          || (wading && floor - c.ck <= this._haulReach(mob)))) {
        // The `vel.k <= 0` is a second belt against the escalator described on
        // _groundUnder: a body on its way *up* — mid-hop, or shoved by a blow —
        // is never also stepping up onto something. On the ground vel.k is
        // negative every frame before this runs, gravity having been applied
        // just above, so ordinary walking is unaffected.
        // Climb a step by raising the real position at a bounded rate, not by
        // snapping it and then *drawing the animal lower* to hide the pop. That
        // is what the old stepLag did, and it rendered the body up to 2.5 cells
        // below where it actually was — i.e. buried in the block it had just
        // climbed. Collision was right; the visible animal was inside terrain.
        // Keeping drawn and physical positions identical is the whole fix.
        // Resolve the height in the same frame as the horizontal move, and
        // draw the animal exactly where it is. Both of the alternatives put the
        // body inside geometry: the old stepLag drew it *below* its position —
        // buried in the block it had just climbed — and easing the real height
        // upward leaves it half-inside the step for as long as the ease lasts,
        // because the horizontal move onto the step has already happened. A
        // one-block pop is brief and honest; a body inside a block is not.
        c.ck = floor;
        mob.vel.k = 0;
        // hoppers bounce along instead of gliding
        if (spec.hops && moving && Math.random() < dt * 2.6) mob.vel.k = spec.hopImpulse;
        mob.grounded = true;
      } else {
        mob.grounded = false;
      }
      if (c.ck < 1) { c.ck = 1; mob.vel.k = 0; }

      // How much ground that was, in cells per second, smoothed over about a
      // fifth of a second so a single refused frame does not flicker the clip.
      // Read by _animate, which takes the lesser of this and `speedNow`.
      const wentI = (c.ci - fromI) * fr.arcA, wentJ = (c.cj - fromJ) * fr.arcB;
      const went = Math.hypot(wentI, wentJ) / Math.max(1e-4, dt);
      mob.gait += (went - mob.gait) * Math.min(1, dt * 6);

      // --- fall damage ------------------------------------------------------
      //
      // Mobs took none at all before this, and the reason it never came up is
      // the reason it now has to exist: the walking rules would not let one
      // step off anything worth falling from, so the only bodies in the air
      // were hopping ones. The moment a blow can throw an animal off a cliff,
      // an animal that gets up unhurt at the bottom makes the throw pointless
      // — and the same clock catches the block mined out from under it.
      //
      // Measured in layers, which is what c.ck already is: a height above
      // R_MIN. No radius appears here and none should, so the planet can be
      // resized under it without a number in this file moving. The peak is
      // tracked rather than the moment the descent began, for the same reason
      // the player's is: a hopper's arc starts on the way *up*.
      if (mob.climbGrace > 0) { mob.climbGrace -= dt; mob.fallFrom = null; }
      if (!mob.grounded && !swimming && !wading && !flying) {
        if (mob.climbGrace <= 0 && mob.fallFrom === null && mob.vel.k < -0.2) mob.fallFrom = prevCk;
        else if (mob.fallFrom !== null && c.ck > mob.fallFrom) mob.fallFrom = c.ck;
      } else if (mob.fallFrom !== null) {
        const drop = mob.fallFrom - c.ck;
        mob.fallFrom = null;
        // Water breaks a fall, exactly as it does for the player — which is
        // also what makes shoving something into a river a way of moving it
        // rather than a way of killing it.
        if (drop > MOB_FALL_FREE && !inWater) {
          const dmg = Math.round((drop - MOB_FALL_FREE) * MOB_FALL_PER_BLOCK);
          if (dmg > 0 && this._damage(mob, dmg)) continue;
        }
      }

      // Lava. The footprint test refuses to walk into it, so the only way a
      // body is standing in this is that something put it there — a shove, a
      // bucket, or the block it was standing on being mined.
      if (inLava) {
        // Relights for as long as the body is in it, and the first instalment
        // of the afterburn is always a full period away — so climbing out is
        // 0.9s of grace and then the toll, which is what the player gets.
        mob.alight = LAVA_BURN_SECONDS;
        mob.alightT = LAVA_BURN_PERIOD;
        mob.lavaT -= dt;
        if (mob.lavaT <= 0) {
          mob.lavaT = LAVA_PERIOD;
          if (this._damage(mob, LAVA_DPS * LAVA_PERIOD)) continue;
        }
      } else {
        mob.lavaT = 0;
        // Out of the lava and still on fire. One compare per mob per frame for
        // everything that is not — which is everything, almost always — and two
        // subtractions for the one that is.
        if (mob.alight > 0) {
          // Water puts it out at once, exactly as it does for the player, so
          // shoving a burning animal in the river is the answer for it too.
          // Rain is not checked here for the same reason main.js does not check
          // it: the player standing in a downpour goes on burning, and a mob
          // that a shower saved and a player that one did not would be a new
          // asymmetry in place of the one this closes.
          if (inWater) { mob.alight = 0; mob.alightT = 0; } else {
            // Clamped rather than left to go a frame negative: `alight > 0` is
            // read by the fire tint in _animate as well as by this branch, and
            // "still burning" should stop being true on the same frame here and
            // there.
            mob.alight = Math.max(0, mob.alight - dt);
            mob.alightT -= dt;
            // The tell. Same call and same cadence as the daylight burn above,
            // so a burning animal reads the same whatever lit it. Two guards,
            // both about not being seen twice: `burnT` means the daylight
            // branch is already emitting for this body and a husk that walked
            // out of lava at noon would otherwise smoke at double rate, and
            // `phantom` is the stalker — `_damage` already refuses him, and
            // embers coming off an empty ridge would be him being caught.
            if (!spec.phantom && mob.burnT <= 0.35 && this.onBurn) this.onBurn(mob);
            if (mob.alightT <= 0) {
              mob.alightT = LAVA_BURN_PERIOD;
              if (this._damage(mob, LAVA_BURN_TOLL)) continue;
            }
          }
        }
      }

      // Spines. The same rule that hurts the player, applied to everything else
      // that can walk into one — asked for in the same breath ("it should hurt
      // me and the mobs"), and the half of it that would have been strange to
      // leave out: a cactus that pricks you and not the cow standing in it is a
      // cactus that knows who the player is.
      //
      // Cheap on purpose. This runs for every animal every frame, so it tests
      // the mob's own column and its four tangential neighbours at the two
      // layers a body actually occupies, and only when the timer is due —
      // `_contactHurtAt` returns 0 immediately for the overwhelming majority of
      // animals, which are standing on grass.
      // --- up a tree ---------------------------------------------------------
      //
      // On its own clock rather than hung off the state machine, which is where
      // this started and does not work: the trigger was "finished a walk while
      // standing beside a tree", and over a 5-minute run a monkey produced two
      // such moments — it spends most of its life fleeing, and a rule that only
      // fires between a walk and an idle almost never fires at all. A timer asks
      // the question often enough to matter and costs one subtraction a frame.
      if (spec.climbs) {
        if (mob.climbRestT > 0) mob.climbRestT -= dt;
        mob.climbT -= dt;
        if (mob.climbT <= 0) {
          mob.climbT = CLIMB_PERIOD;
          if (mob.climbTo === null && mob.climbRestT <= 0 && mob.state !== 'flee'
              && Math.random() < CLIMB_CHANCE) {
            const bc = this._colOf(c.f, c.ci, c.cj);
            const top = bc >= 0 ? this._canopyAbove(bc, c.ck) : -1;
            if (top > c.ck && this._climbHold(bc, Math.floor(c.ck))) {
              mob.climbTo = top;
              // The column it is holding on to. Kept so the climb cannot drift
              // out of it — see the pin in the climb branch.
              mob.climbCi = c.ci;
              mob.climbCj = c.cj;
              mob.perchT = PERCH_MIN + Math.random() * (PERCH_MAX - PERCH_MIN);
              // Stop wandering, or it walks out from under its own climb.
              mob.state = 'idle';
              mob.stateT = 4 + mob.perchT;
            }
          }
        }
      }
      mob.contactT -= dt;
      if (mob.contactT <= 0) {
        mob.contactT = CONTACT_PERIOD;
        const spike = this._contactHurtAt(mob);
        if (spike > 0 && this._damage(mob, spike)) continue;
      }

      // Carry the heading through a cube seam in world space, exactly as the
      // player does with its velocity — otherwise the tangent basis flips and
      // the animal whips round on the spot.
      if (c.ci < 0 || c.ci >= F || c.cj < 0 || c.cj >= F) {
        _seam.set(
          fr.ea[0] * ch + fr.eb[0] * sh,
          fr.ea[1] * ch + fr.eb[1] * sh,
          fr.ea[2] * ch + fr.eb[2] * sh,
        );
        normalizeCell(c);
        this._sync(mob);
        const na = _seam.x * fr.ea[0] + _seam.y * fr.ea[1] + _seam.z * fr.ea[2];
        const nb = _seam.x * fr.eb[0] + _seam.y * fr.eb[1] + _seam.z * fr.eb[2];
        const nh = Math.atan2(nb, na);
        mob.want = wrapAngle(mob.want + wrapAngle(nh - mob.heading));
        mob.heading = nh;
      } else {
        this._sync(mob);
      }

      this._animate(mob, dt);
    }

    // Anything eaten this frame is removed here, outside the walk over the list
    // — see the note in _stalk on why a kill cannot splice from inside it.
    if (this._kills.length) {
      for (const prey of this._kills) if (!prey.released) this._die(prey, []);
      this._kills.length = 0;
    }

    // And anything that stopped being looked at, on the same terms and for the
    // same reason. Not through `_die`: no drops, no death clip, no sound, no
    // body left on the ground for a second and a bit. `_release` and a splice
    // is the removal the despawn ring and `_bedDown` already use, which is the
    // one that leaves nothing behind at all.
    if (this._vanished.length) {
      for (const gone of this._vanished) {
        if (gone.released) continue;
        const idx = this.list.indexOf(gone);
        if (idx >= 0) { this._release(gone); this.list.splice(idx, 1); }
      }
      this._vanished.length = 0;
    }

    // Bodies last: shove anything overlapping apart, then re-place the models
    // so the nudge shows this frame rather than the next.
    this._separate(dt, player);
    for (const mob of this.list) this._sync(mob);
  }

  // --- presentation ---------------------------------------------------------

  _animate(mob, dt) {
    const spec = mob.spec, fr = mob.frame, model = mob.model;

    mob.prevPos.copy(mob.pos);

    // --- orientation ---
    // Face the direction of travel, standing on the local up. The head sits at
    // local +Z, so +Z must map to forward — mapping it to -forward walks the
    // animal backwards.
    _fwd.set(0, 0, 0);
    _axis.fromArray(fr.ea); _fwd.addScaledVector(_axis, Math.cos(mob.heading));
    _axis.fromArray(fr.eb); _fwd.addScaledVector(_axis, Math.sin(mob.heading));
    if (_fwd.lengthSq() < 1e-6) _fwd.fromArray(fr.ea);
    _fwd.normalize();
    // up x fwd keeps the basis right-handed with +Z = forward
    _side.crossVectors(mob.up, _fwd).normalize();
    _m.makeBasis(_side, mob.up, _fwd);
    _q.setFromRotationMatrix(_m);

    const root = model.root;
    if (!mob.placed) { root.quaternion.copy(_q); mob.placed = true; }
    else root.quaternion.slerp(_q, 1 - Math.exp(-16 * dt));

    _rpos.copy(mob.pos);
    root.position.copy(_rpos);
    // `grown` is the permanent size a predator has eaten its way to; `lungeT`
    // is the momentary pounce, easing out over LUNGE_TIME so a pet with no
    // attack clip still has weight behind its blow. Both go through here for
    // the reason growthScale documents: this line owns root.scale, and anything
    // written to it elsewhere is gone on the next frame.
    const lunge = mob.lungeT > 0 ? 1 + 0.16 * (mob.lungeT / LUNGE_TIME) : 1;
    root.scale.setScalar(mob.scale * mob.grown * growthScale(mob) * lunge
      * (mob.hurtT > 0 ? 1.09 : 1));

    // --- animation ---
    // The clips carry the whole performance — gait, idle sway, the eating dip.
    // Choosing one is all that is left, and the mixer crossfades between them.
    //
    // A body in water over its head gets the walk, slowed, and never the run.
    // There is no swim clip in the Cube Pets pack — the same gap the lunge
    // works around, and answered the same way: pick the clip that already
    // reads closest and re-time it, rather than pointing at a name that does
    // not exist. A land animal that fell in is *swimming* by the `wading` rule
    // in update(), so its ground speed is a full SWIM_SPEED gait and the clip
    // chain below put it on `run` — a tiger sprinting on the spot across a
    // lake, which is what was reported. Idle was the other candidate and is
    // worse: the body is genuinely travelling, so idle skates. A halved walk
    // cycle is legs moving under a body that is going somewhere, which is what
    // a dog paddle looks like from outside the water, and the vertical bob the
    // wading buoyancy already applies supplies the rest.
    //
    // `mob.wading` only, not `swimming`: a fish and a crab are at home in the
    // water and their own clips were authored for it.
    // What the legs are worth, which is not always what the animal intends.
    //
    // `speedNow` is a wish: it is rebuilt every frame from the state machine and
    // knows nothing about whether the terrain let the body go anywhere. A mob
    // walled in — against a shore, in a pen, at the foot of a bank it cannot
    // climb — held a full run cycle while covering no ground at all, and "the
    // tiger is doing the running animation but is not moving" is the only part
    // of that bug the player can actually see. `gait` is the ground it really
    // covered, and the lesser of the two is what the clip is chosen from, so
    // this can only ever quieten an animation and never speed one up.
    //
    // Paddling is exempt and has to be: a body held at the water line by
    // buoyancy is travelling perfectly well, and its clip is a flat rate
    // already (see the note below).
    const legs = mob.wading ? mob.speedNow : Math.min(mob.speedNow, mob.gait);
    const paddling = mob.wading && mob.dying <= 0;
    let clip = spec.clips.idle;
    if (mob.dying > 0) clip = spec.clips.die || spec.clips.idle;
    else if (paddling) clip = spec.clips.walk;
    else if (legs > spec.speed * 1.25) clip = spec.clips.run;
    else if (legs > 0.06) clip = spec.clips.walk;
    else if (mob.state === 'graze') clip = spec.clips.graze;
    MobModels.play(model, clip, mob.placedClip ? 0.2 : 0, mob.dying > 0);
    mob.placedClip = true;

    // Play the walk faster the quicker it moves, so feet do not skate. The
    // clips are authored at roughly one unit per second.
    //
    // Both bases are the species' *wander* pace, which is what makes the chase
    // and flee multipliers safe: a gait of M times the wander lands on the run
    // clip (the swap above is at 1.25×) and plays it at M/2, so FLEE_SPEED 2.2
    // reads as 1.1 and CHASE_SPEED 3.0 as 1.5. The clamp bites at 0.45 and 2.2,
    // i.e. at multipliers of 0.9 and 4.4, and every multiplier in this file sits
    // between them — nothing skates, and nothing is running on a pinned clip.
    // That headroom is the reason the speed ladder puts the burst in the
    // multiplier and leaves `spec.speed` alone: raising the base raises the
    // divisor with it, so a faster amble covers more ground at an unchanged 1.0
    // and the animal skates while standing still in the numbers.
    const walking = clip === spec.clips.walk || clip === spec.clips.run;
    const act = model.actions[clip];
    if (act && paddling) {
      // Flat, and deliberately not derived from speedNow the way the gaits
      // below are. Every one of those divisors is a *ground* pace and reads
      // "how fast are the feet passing the floor", which is a question with no
      // answer for a body that is not touching one — a swimming animal driven
      // by the same rule speeds its legs up as the current carries it, which is
      // the skating this whole block exists to prevent, in the one case where
      // there is nothing to skate on.
      act.setEffectiveTimeScale(WADE_CLIP_RATE);
    } else if (act && walking) {
      const base = clip === spec.clips.run ? spec.speed * 2 : spec.speed;
      act.setEffectiveTimeScale(clamp(legs / Math.max(0.15, base), 0.45, 2.2));
    } else if (act) {
      act.setEffectiveTimeScale(1);
    }
    model.mixer.update(dt);

    // --- damage and fire tint ---
    // Multiplied into the texture rather than added on top of it, so a struck
    // animal reddens instead of glowing. `owned` is this mob's own material
    // clones; the map inside them is shared and never written to.
    let tr = 1, tg = 1, tb = 1;

    // --- this body's own sky, not the player's -------------------------------
    //
    // "Why are light for blocks and models different? Sun and moon affect the
    // environment properly but not mobs."
    //
    // Block light already is shared: `_entityLight` samples the same emitters
    // the terrain does, through the same falloff. Sky light was not. The
    // terrain carries a baked per-voxel sky value, so a cow in a cave is dark
    // and one in a field is bright, cell by cell - but a mob cannot have baked
    // vertex light because it moves, so it takes a single scene fill, and that
    // fill is dimmed by the *player's* sky exposure. An animal under a canopy
    // was lit by whatever you were standing under.
    //
    // So each body now answers for itself, with the same probe the weather uses
    // on the player: walk up its own column and count what is over it, giving up
    // at three. Sampled on a jittered timer rather than every frame - the sky
    // over a cow changes when it walks under a tree, which is not a per-frame
    // event - and quantised to sixteenths so the change guard below still holds
    // and a wandering animal does not rewrite its materials every frame.
    mob.skyT = (mob.skyT || 0) - dt;
    if (mob.skyT <= 0) {
      mob.skyT = SKY_PROBE_PERIOD * (0.75 + Math.random() * 0.5);
      const c = mob.cell;
      const col = this._colOf(c.f, c.ci, c.cj);
      let blocked = 0;
      for (let k = Math.floor(c.ck) + 2; k < D; k++) {
        if (this.planet.solidAt(col, k) && ++blocked >= 3) break;
      }
      const open = 1 - Math.min(3, blocked) / 3;
      mob.sky = Math.round((SKY_SHADE_MIN + (1 - SKY_SHADE_MIN) * open) * 16) / 16;
    }
    const sky = mob.sky ?? 1;
    tr *= sky; tg *= sky; tb *= sky;

    if (mob.hurtT > 0) { tr = 1; tg = 0.34; tb = 0.30; }
    // `alight` is the lava afterburn, `burnT` the daylight one. Same tint for
    // both: what the player has to read is "that animal is on fire", not which
    // clock is counting it down.
    else if (mob.burnT > 0 || mob.alight > 0) {
      // pulse while alight, so a burning husk reads at a distance
      const beat = 0.65 + Math.abs(Math.sin(mob.idleT * 9)) * 0.35;
      tr = 1; tg = 0.55 * beat; tb = 0.22 * beat;
    }
    if (mob.tintR !== tr || mob.tintG !== tg || mob.tintB !== tb) {
      mob.tintR = tr; mob.tintG = tg; mob.tintB = tb;
      // Multiplied into the material's own colour, not written over it.
      //
      // Setting it outright was fine for as long as every animal was textured:
      // their base colour is white and the coat comes from the map, so
      // white-times-texture is the texture. The fish are painted in the
      // material instead — no map at all, one flat colour per fin — and this
      // line repainted every one of them white on the first frame, so a
      // clownfish arrived as a pale blob. `baseColor` is captured at spawn for
      // exactly this.
      for (const m of model.owned) {
        if (!m.color) continue;
        const b = m.userData.baseColor;
        if (b) m.color.setRGB(tr * b.r, tg * b.g, tb * b.b);
        else m.color.setRGB(tr, tg, tb);
      }
    }

    // --- block light ---
    // What a torch, a lantern, a lit kiln or a lake of lava does to a body
    // standing next to it. Every one of those is baked into the voxel grid and
    // a mob is not a chunk, so until this existed a mob got nothing from any of
    // them: the animals were lit by the sky alone, and a cave with a torch in it
    // lit the walls and left the cow in front of them black. See
    // `main._entityLight` for where the answer comes from and what it costs.
    //
    // Probed at half height rather than at the feet, so a wall torch — which is
    // bracketed a block up — lights the body and not just the ground it stands
    // on.
    //
    // Multiplied by the same tint the albedo takes, so a struck animal beside a
    // fire still reddens: the tint darkens green and blue in the diffuse, and
    // without this the emissive would have gone on adding untinted firelight
    // over the top and washed the flash out at exactly the moment it matters.
    // ...and not for a phantom, whose entire appearance is that he does not
    // pick anything up from the world he is standing in. He has no emissiveMap
    // (see spawn), so this would add one flat colour over the whole body — the
    // "coat of paint" the paragraph above warns about — and it would do it
    // exactly where a torch or a lit doorway is, which is where he most needs
    // to stay a shape.
    if (this.blockLightAt && !spec.shade) {
      _lit.copy(mob.pos).addScaledVector(mob.up, mob.spec.height * 0.5);
      const bl = this.blockLightAt(_lit, _blockL);
      const er = bl.r * tr, eg = bl.g * tg, eb = bl.b * tb;
      // A 1/255 deadband. A mob walking past a torch changes this every frame
      // and a herd is ~22 part materials each; the guard means a still animal
      // in an unlit field costs one comparison rather than a write per part.
      if (Math.abs(er - (mob.emR || 0)) > 0.004 || Math.abs(eg - (mob.emG || 0)) > 0.004
        || Math.abs(eb - (mob.emB || 0)) > 0.004) {
        mob.emR = er; mob.emG = eg; mob.emB = eb;
        for (const m of model.owned) if (m.emissive) m.emissive.setRGB(er, eg, eb);
      }
    }
  }

  // --- interaction ----------------------------------------------------------

  /** Closest mob along a ray, within maxDist. */
  raycast(origin, dir, maxDist) {
    let best = null, bestT = maxDist;
    for (const mob of this.list) {
      // A phantom is not there to be aimed at. This is the single line that
      // makes him undamageable, unfeedable and un-right-clickable, because
      // every one of those in main.js starts from this raycast — and it is also
      // what keeps the crosshair from lighting up over him, which would give
      // away that the game considers him a thing at all.
      if (mob.spec.phantom) continue;
      // Aim at the body, sized from the measured footprint. This used to derive
      // both from `scale`, which was ~1 for every hand-built species but is now
      // a model-specific conversion factor — a husk's is not a cow's.
      const r = mob.radius + 0.20;
      _ray.copy(mob.pos).addScaledVector(mob.up, mob.spec.height * 0.5).sub(origin);
      const t = _ray.dot(dir);
      if (t < 0 || t > bestT) continue;
      const perp = _ray.addScaledVector(dir, -t).length();
      if (perp > r) continue;
      best = mob; bestT = t;
    }
    return best ? { mob: best, dist: bestT } : null;
  }

  /**
   * Offer food to an animal. A fed adult goes looking for a mate; two willing
   * animals of the same species that find each other produce a calf.
   * @returns {boolean} true if the animal accepted the food
   */
  /** Is this something an animal will eat? Used for the crosshair prompt. */
  canFeed(itemId) { return FEEDS.has(itemId); }

  feed(mob, itemId) {
    if (!mob || mob.health <= 0) return false;
    // He is not an animal and there is nothing to be got from him. Unreachable
    // today — `raycast` already filters phantoms, so nothing can be offered to
    // him — and written down anyway, because it is the only thing that can set
    // `love`, and `love` is the whole of the breeding path. Two stalkers
    // courting each other is prevented at present by a cap of one and by a
    // door nobody has opened; a rule is cheaper than either.
    if (mob.spec.phantom) return false;
    if (!FEEDS.has(itemId)) return false;
    if (mob.baby > 0) {
      // Feeding a calf just brings it up faster — it can't breed yet.
      mob.baby = Math.max(0, mob.baby - BABY_SECONDS * 0.28);
      mob.love = 0;
      if (this.onSound) this.onSound('idle', mob);
      return true;
    }
    if (mob.love > 0 || mob.breedCooldown > 0) return false;
    mob.love = LOVE_SECONDS;
    mob.state = 'idle';
    mob.stateT = 0.5;
    if (this.onSound) this.onSound('idle', mob);
    return true;
  }

  /** Willing pairs of the same species that have found each other. */
  _tickBreeding(dt) {
    const list = this.list;
    for (let a = 0; a < list.length; a++) {
      const m = list[a];
      if (m.baby > 0) {
        mobGrow(m, dt);
        continue;
      }
      if (m.breedCooldown > 0) m.breedCooldown -= dt;
      if (m.love <= 0) continue;
      m.love -= dt;
      if (m.love <= 0) continue;

      for (let b = a + 1; b < list.length; b++) {
        const o = list[b];
        if (o.type !== m.type || o.love <= 0 || o.baby > 0 || o.breedCooldown > 0) continue;
        if (m.pos.distanceToSquared(o.pos) > BREED_RANGE * BREED_RANGE) continue;
        // pair off: both spend their affection and rest before breeding again
        m.love = 0; o.love = 0;
        m.breedCooldown = BREED_COOLDOWN;
        o.breedCooldown = BREED_COOLDOWN;
        const calf = this.spawn(m.type, this._colOf(m.cell.f, m.cell.ci, m.cell.cj),
          Math.floor(m.cell.ck));
        if (calf) {
          calf.baby = BABY_SECONDS;
          calf.breedCooldown = BABY_SECONDS + BREED_COOLDOWN;
          mobGrow(calf, 0);
          if (this.onSound) this.onSound('idle', calf);
        }
        break;
      }
    }
  }

  /** @param {number} knock 0..1 — how much of the shove this blow carries. */
  hurt(mob, damage, fromPos, knock = 1) {
    // Belt and braces. `raycast` already refuses to hand a phantom to the
    // swing, so main.js can never reach this — but `hurt` is the public door
    // into the damage system and the next caller of it will not know that.
    if (mob.spec.phantom) return false;
    if (mob.dying > 0) return false;
    mob.health -= damage;
    mob.hurtT = 0.25;
    const fr = mob.frame;
    _rel.copy(mob.pos).sub(fromPos);
    const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
    const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
    // Shove it away from whoever swung. `ra`/`rb` are already the offset in the
    // mob's own tangent frame, so normalising them gives the push direction on
    // the curved surface without any further trigonometry.
    const rl = Math.hypot(ra, rb) || 1;
    // A charged swing throws; a hurried one still shifts. main.js passes 1 or 0
    // on either side of an 85% charge, and 0 meant a blow with no shove at all
    // — which is most blows, and is why the knockback was reported missing
    // rather than reported weak.
    const weight = KNOCK_FLOOR + (1 - KNOCK_FLOOR) * clamp(knock, 0, 1);
    // Scaled by what it weighs, which is the difference between a knockback and
    // a physics glitch: a bunny should leave, an elephant should rock and stay
    // exactly where it was standing. See knockMass for the ladder.
    const mass = knockMass(mob.baseHeight ? mob.baseHeight * mob.grown : mob.spec.height);
    const push = (mob.spec.hostile || mob.spec.monster || mob.spec.predator ? KNOCK_HOSTILE
      : mob.spec.trader ? KNOCK_HOSTILE * 0.5 : KNOCK_WILDLIFE) * weight * mass;
    if (push > 0) {
      mob.knockA = (ra / rl) * push;
      mob.knockB = (rb / rl) * push;
      mob.knockT = KNOCK_TIME;
      // The shove is now something that happens *to* the body rather than
      // something it agrees to. Until it lands again the walking rules are off
      // — see the tumble in update() — which is the only reason any of this
      // can put an animal anywhere it would not have walked.
      mob.tumbling = true;
    }

    if (mob.spec.hostile || mob.spec.monster || mob.spec.predator) {
      // Hitting a husk makes it angry, not skittish: it takes the knock but
      // keeps coming, and it now knows exactly where you are.
      //
      // Predators go through the same door, and this is the whole of the
      // retaliation fix. A tiger was ordinary wildlife with a big-cat model:
      // it had no damage, no reach and no swing, `_hunt` was gated on `hostile`
      // so it was never even asked, and this branch sent it to 'flee'. Swinging
      // at one made it run away — the single most confusing thing on the
      // planet, since everything about it says predator. Now it drops whatever
      // it was doing, forgets the meal it was stalking, and comes for you.
      mob.target = 'player';
      mob.prey = null;
      mob.state = 'chase';
      mob.stateT = 0.5;
      mob.vel.k = KNOCK_LIFT * 0.4 * mass;
    } else if (mob.spec.trader) {
      // It has seen worse. Bolting would also strand its stock somewhere you
      // cannot follow, and there is only ever one.
      mob.vel.k = KNOCK_LIFT * 0.35 * mass;
    } else {
      mob.state = 'flee';
      mob.stateT = 2.5;
      mob.want = Math.atan2(rb, ra);      // bolt away from whatever hit it
      // Straight to the full bolt rather than accelerating into it. This was
      // speed * 1.4, which was a genuine burst back when fleeing was 2× the
      // wander and is now *below* the flee target — so the one frame that is
      // supposed to read as a start would have quietly braked the animal.
      mob.speedNow = mob.spec.speed * FLEE_SPEED;
      // Off its feet, and by how much it weighs. The lift is what turns a shove
      // into a throw: on the ground the floor clamp puts the body straight back
      // down and the push is spent sliding, and a body in the air keeps every
      // bit of it. This is the difference between a bunny clearing the river
      // bank and a bunny scuffing along it.
      mob.vel.k = KNOCK_LIFT * mass;
    }
    // Pain and death are never rate-limited — they are always the player's
    // own doing, and there is at most one per swing.
    if (this.onSound) this.onSound(mob.health <= 0 ? 'death' : 'hurt', mob);

    if (mob.health <= 0) {
      // A calf isn't worth anything — killing one should feel like a waste,
      // not a shortcut past the grow-up timer.
      this._die(mob, mob.baby > 0 ? [] : mob.spec.drops);
      return true;
    }
    return false;
  }

  toJSON() {
    return {
      // The merchant's wait has to outlive a session, or quitting and reloading
      // is a way to skip it.
      cooldown: +this.merchantT.toFixed(1),
      // A stalker is never written down. He exists only for as long as he is
      // being looked at, and a save taken during a sighting that restored him
      // to the same hillside on load would make him a landmark — which is the
      // opposite of the only thing he is. `fromJSON` needs no matching guard:
      // there is nothing in the file to skip.
      mobs: this.list.filter((m) => !m.spec.phantom).map((m) => {
        const d = {
          t: m.type, c: [m.cell.f, m.cell.ci, m.cell.cj, m.cell.ck], h: m.health, s: m.seed,
          b: +m.baby.toFixed(1), l: +m.love.toFixed(1), d: +m.breedCooldown.toFixed(1),
        };
        // Size eaten for is earned, and it is also worth double loot — losing
        // it on a reload would make the reload the mistake.
        if (m.grown > 1) d.g = +m.grown.toFixed(3);
        // Which of the two husk budgets this one is counted against.
        //
        // Not decoration either: `_countHostile(cave)` keys entirely off this
        // flag, and it defaulted to false on every load. So a world saved with
        // four husks in a dungeon and six on the surface came back reading zero
        // cave husks and ten surface ones — the spawner immediately made four
        // more underground, taking twelve hostiles against caps of eight and
        // four, while refusing to spawn a single surface husk all night. Saving
        // again laundered the new ones into the surface budget too, so it
        // compounded every session. The split budgets exist precisely to stop a
        // dungeon the player has never entered from eating the night.
        if (m.fromCave) d.cv = 1;
        // A trader's stock and remaining life are state, not decoration.
        // Re-rolling them on load would make quit-and-reload the cheapest way
        // to shop: reload until the wares are the ones you wanted, and buy the
        // same limited line as many times as you like.
        if (m.spec.trader) {
          d.st = m.stock.map((s) => [s.item, s.count]);
          d.lf = +m.life.toFixed(1);
          d.pu = m.purse.coins;
          // A filled request must stay filled, or reloading pays you twice.
          if (m.request) d.rq = [m.request.item, m.request.count, m.request.reward,
            m.request.done ? 1 : 0];
        }
        return d;
      }),
    };
  }

  fromJSON(data) {
    this.clear();
    // Saves written before the merchant existed are a bare array of mobs.
    const arr = Array.isArray(data) ? data : (data?.mobs || []);
    this.merchantT = Array.isArray(data)
      ? MERCHANT_FIRST
      : (data?.cooldown ?? MERCHANT_FIRST);
    for (const d of arr) {
      if (!SPECIES[d.t]) continue;
      const col = cidx(d.c[0], Math.floor(d.c[1]), Math.floor(d.c[2]));
      const mob = this.spawn(d.t, col, Math.floor(d.c[3]) - 1, d.s);
      if (mob) {
        mob.cell.ci = d.c[1]; mob.cell.cj = d.c[2]; mob.cell.ck = d.c[3];
        mob.health = d.h;
        // A calf must come back a calf, at the size it had grown to.
        mob.baby = d.b ?? 0;
        mob.love = d.l ?? 0;
        mob.breedCooldown = d.d ?? 0;
        if (d.g > 1) this._setGrowth(mob, d.g);
        // Absent in older saves, where false is the right answer: those worlds
        // had no split budget to be counted against.
        mob.fromCave = !!d.cv;
        if (mob.spec.trader) {
          if (d.st) mob.stock = d.st.map(([item, count]) => ({ item, count }));
          if (d.lf !== undefined) mob.life = d.lf;
          // A spent purse must stay spent, or reloading refills the trader and
          // the cap means nothing.
          if (d.pu !== undefined) mob.purse.coins = d.pu;
          mob.request = d.rq
            ? { item: d.rq[0], count: d.rq[1], reward: d.rq[2], done: !!d.rq[3] }
            : null;
        }
        mobGrow(mob, 0);
        this._sync(mob);
        mob.prevPos.copy(mob.pos);
      }
    }
  }
}
