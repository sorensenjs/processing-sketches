'use strict';

// TODO:
// - behavior:
// - display:
//   - less bleh control panel
// - misc:
//   - module-ify quadtree?
//   - add icon for manifest... https://developers.google.com/web/fundamentals/web-app-manifest/
//   - make random movement less jittery.

let FLOCKS = [];

const MOBILE = /Mobi|Android/i.test(navigator.userAgent);
const GROUP_SIZE_RANDBOUND = MOBILE ? [70, 150] : [100, 200];
const NUM_GROUPS_RANDBOUND = MOBILE ? [2, 2] : [2, 3];
const SPEED_RANDBOUND = [2, 5];
const NODE_SIZE_RANDBOUND = MOBILE ? [4, 7] : [6, 12];

// When increasing/decreasing flock sizes, change by this frac of existing size.
const FLOCK_SIZE_CHANGE_FRAC = 0.1;
const SPEED_LIMIT_MULT = 10;
let SPEED_AVG_WEIGHT = 0.90;
let SPEED_CUR_WEIGHT = 0.1;
let TOUCH_RAD = 70;

// Control panel input elements.
let PAUSED = false;
let I_SPEED_MULT;
let I_ZOOM;
let I_MOUSE_REPEL;
let I_CIRCLES;
let I_BACKGROUND;
let I_SURROUND_OR_CLOSEST;
let I_DEBUG_FORCE;
let I_DEBUG_NEIGHBORS;
let I_DEBUG_DISTANCE;
let I_DEBUG_QUADTREE;

let I_NF_SEPARATION_FORCE;
let I_SEPARATION_FORCE;
let I_COHESION_FORCE;
let I_ALIGNMENT_FORCE;
let I_MAX_FORCE;
let I_NATURAL_SPEED_WEIGHT;
let I_SPACE_AWARE_MULT;
let I_NUM_NEIGHBORS;
let I_NF_NUM_NEIGHBORS;
let I_RAND_MOVE_FREQ;
let I_RAND_MOVE_MULT;


// Note: has high saturation and brightness minimums.
let RAND_HUE;  // initialized in setup.
function rand_color() {
  const c = color(RAND_HUE, random(85, 100), random(80, 85));
  RAND_HUE = (RAND_HUE + random(60, 100)) % 360;
  return c;
}

function rand_position() { return createVector(random(0, width), random(0, height)); }

// Plus 1 for int upper bound so that bounds are inclusive.
function rand_bound(bounds) { return floor(random(bounds[0], bounds[1] + 1)); }

function map2(x, dom_lo, dom_mid, dom_hi, rng_lo, rng_mid, rng_hi) {
  if (x >= dom_mid) { return map(x, dom_mid, dom_hi, rng_mid, rng_hi); }
  else { return map(x, dom_lo, dom_mid, rng_lo, rng_mid); }
}

// Note: the effect is highly dependent on SPEED_{AVG,CUR}_WEIGHT. Oh well.
function relspeed_color_shift(col, relspeed) {
  let h = hue(col), s = saturation(col), b = brightness(col);

  const hue_delta = constrain(map(relspeed, 0.5, 1.5, -50, 50), -100, 100);
  h = h + hue_delta % 360;

  b = constrain(b * map2(relspeed, 0.5, 1.0, 1.2,  0.25, 1.0, 2.0), 10, 100);

  return color(h, s, b);
}

function draw_triangle(middle, dir, size) {
  dir = dir.copy().setMag(size);
  const halfdir = dir.copy().mult(.5);
  const v1 = p5.Vector.add(middle, halfdir);
  const base = p5.Vector.sub(middle, halfdir);
  const v2 = p5.Vector.add(base, dir.copy().mult(.3).rotate(HALF_PI));
  const v3 = p5.Vector.add(base, dir.copy().mult(.3).rotate(-HALF_PI));
  triangle(v1.x, v1.y, v2.x, v2.y, v3.x, v3.y);
}

// The distance computation doesn't recognize that nodes on the other side of
// the screen are actually "nearby". This can cause some glitching, with nodes
// hopping back and forth due to forces from neighbors. WRAP_HACK is used so
// that when nodes wrap around the plane, they get some extra buffer to avoid
// the glitching. TODO: fix the distance computation instead?
const WRAP_HACK = 10;

function wrap_dimension(x, upper) {
  if (x > upper) { x = x - upper + WRAP_HACK; }
  else if (x < 0) { x = upper - x - WRAP_HACK; }
  return x;
}

function wrap_vector(v) {
  v.x = wrap_dimension(v.x, width);
  v.y = wrap_dimension(v.y, height);
}

// Returns heading from 0 to 2PI instead of 0 to PI and 0 to -PI.
function heading_pos(v) {
  const h = v.heading();
  // heading is weird: goes from 0 to 180, then -180 to 0.
  if (h >= 0) return h;
  return map(h, -PI, 0, PI, 2*PI);
}

class Node {
  constructor(id, flock_id, pos, vel, space_need, col, size) {
    this.id = id; this.flock_id = flock_id;
    this.pos = pos; this.vel = vel;
    this.space_need = space_need;
    this.col = col; this.size = size;
    this.speed_avg = this.speed_cur = this.natural_speed = this.vel.mag();
  }
  copy() {
    return new Node(this.id, this.flock_id, this.pos.copy(), this.vel.copy(),
                    this.space_need, this.col, this.size);
  }
  get speed_limit() { return this.natural_speed * SPEED_LIMIT_MULT; }
  get zspace_need() { return this.space_need * I_ZOOM.value; }
  get debugf() { return I_DEBUG_FORCE.value && this.id === 0; }

  draw_shape() {
    const siz = this.size * I_ZOOM.value;
    if (I_CIRCLES.value) { ellipse(this.pos.x, this.pos.y, siz, siz); }
    else { draw_triangle(this.pos, this.vel, siz); }
  }

  draw() {
    noStroke();
    if (this.debugf) { fill(100); }
    else { fill(relspeed_color_shift(this.col, this.speed_cur/this.speed_avg)); }
    this.draw_shape();
    if (I_DEBUG_DISTANCE.value) {
      noFill();
      strokeWeight(0.5);
      stroke(this.id === 0 ? 85 : 35);
      // Note: this is drawing a diameter of space_need instead of the radius.
      // This works out since with 2 nodes, the 2 bubbles looks like they're
      // bumping against each other.
      ellipse(this.pos.x, this.pos.y, this.zspace_need, this.zspace_need);
      if (this.id === 0) {
        stroke(110, 80, 60);
        // Here, we do properly draw the radius since we're only showing 1 side.
        const s = 2 * I_SPACE_AWARE_MULT.value * this.zspace_need;
        ellipse(this.pos.x, this.pos.y, s, s);
        line(this.pos.x, this.pos.y, this.pos.x + s/2, this.pos.y);
      }
    }
  }

  get_nearest_nodes(flocks, qt) {
    // same flock and not-same flock
    const nodes_and_dists_sf = [];
    const nodes_and_dists_nf = [];
    const max_dist = I_SPACE_AWARE_MULT.value * this.zspace_need;
    const near = qt.queryCenter(this.pos, max_dist, max_dist);
    for (const [other, _] of near) {
      const same_flock = this.flock_id === other.flock_id;
      if (same_flock && this.id === other.id) continue;
      const dist = this.pos.dist(other.pos);
      if (dist < max_dist) {
        if (same_flock) { nodes_and_dists_sf.push([other, dist]); }
        else { nodes_and_dists_nf.push([other, dist]); }
      }
    }
    nodes_and_dists_sf.sort((a, b) => a[1] - b[1]).splice(I_NUM_NEIGHBORS.value);
    nodes_and_dists_nf.sort((a, b) => a[1] - b[1]).splice(I_NF_NUM_NEIGHBORS.value);
    return nodes_and_dists_sf.concat(nodes_and_dists_nf);
  }

  get_surrounding_nodes(flocks, qt) {
    // HACK: reusing existing sliders...
    const num_segments = I_NUM_NEIGHBORS.value;
    const num_per_segment = I_NF_NUM_NEIGHBORS.value;
    const rad_per_segment = 2 * PI / num_segments;
    const nodes_and_dists_per_segment = [];
    // Initialize.
    for (let i = 0; i < num_segments; ++i) { nodes_and_dists_per_segment[i] = []; }
    // TODO: previously, used avg of this and other's spaceneed to react. should
    // we still do that? if we don't then neighbors from flocks w/ greater space
    // need react to this node before this node reacts to it. could add some
    // safety factor to account, maybe? bleh.
    const max_dist = I_SPACE_AWARE_MULT.value * this.zspace_need;
    const near = qt.queryCenter(this.pos, max_dist, max_dist);
    for (const [other, _] of near) {
      if (this.flock_id === other.flock_id && this.id === other.id) continue;
      const dist = this.pos.dist(other.pos);
      if (dist < max_dist) {
        const to_other = other.pos.copy().sub(this.pos);
        const segment = int(heading_pos(to_other) / rad_per_segment);
        nodes_and_dists_per_segment[segment].push([other, dist]);
      }
    }
    let nodes_and_dists = []
    for (const segment of nodes_and_dists_per_segment) {
      segment.sort((a, b) => a[1] - b[1]).splice(num_per_segment);
      segment.forEach(nd => nodes_and_dists.push(nd));
    }
    return nodes_and_dists;
  }

  update(flocks, qt, mouse_pos) {
    const nearby_nodes = (I_SURROUND_OR_CLOSEST.value
                          ? this.get_surrounding_nodes(flocks, qt)
                          : this.get_nearest_nodes(flocks, qt));

    const curspeed = this.vel.mag();
    const max_space_awareness = I_SPACE_AWARE_MULT.value * this.zspace_need;
    const sep_force = createVector(); let sep_n = 0;
    const ali_force = createVector(); let ali_n = 0;
    for (const [other, dist] of nearby_nodes) {
      // numerator for separation force computation. with divisor of dist^2,
      // this works out to 1 when other node is zspace_need away.
      const sep_force_num = this.zspace_need * other.zspace_need;
      const same_flock = this.flock_id === other.flock_id;
      const away = p5.Vector.sub(this.pos, other.pos).normalize();
      if (same_flock) {
        sep_force.add(away.copy().mult(
          I_SEPARATION_FORCE.value * curspeed * sep_force_num / sq(dist)
          - I_COHESION_FORCE.value * curspeed * dist / this.zspace_need
        )); ++sep_n;
        ali_force.add(other.vel); ++ali_n;
      } else {
        sep_force.add(away.copy().mult(
          I_NF_SEPARATION_FORCE.value * curspeed * sep_force_num / pow(dist, 2)
        )); ++sep_n;
      }
      if (I_DEBUG_NEIGHBORS.value && (!I_DEBUG_FORCE.value || this.debugf)) {
        if (same_flock && dist < this.zspace_need) {
          strokeWeight(2);
          stroke(330, 90, map(dist, 3, this.zspace_need, 100, 40));
        } else if (same_flock) {
          strokeWeight(0.5);
          stroke(120, 85, map(dist, this.zspace_need, max_space_awareness, 35, 100));
        } else {
          strokeWeight(1);
          stroke(210, 95, map(dist, 3, max_space_awareness, 100, 20));
        }
        line(this.pos.x, this.pos.y, other.pos.x, other.pos.y);
      }
    }

    if (mouse_pos) {
      // HACK: some magic numbers here... large repel multiplier to make
      // repelling more dramatic. also using log(dist^2) (as opposed to more
      // usual dist) to lessen attractive force, since it feels a bit more
      // natural. When multiplying just by 'dist', every node just heads
      // straight for the mouse, since we aren't limiting  to only nodes within
      // some radius.
      const away = this.pos.copy().sub(mouse_pos);
      const dist_sq = away.magSq();
      if (I_MOUSE_REPEL.value && dist_sq < sq(TOUCH_RAD)) {
        ++sep_n;
        sep_force.add(away.setMag(
          50 * I_SEPARATION_FORCE.value * curspeed * TOUCH_RAD * this.zspace_need / dist_sq));
      } else if (!I_MOUSE_REPEL.value) {
        ++sep_n;
        sep_force.add(away.setMag(
          -2 * I_COHESION_FORCE.value * curspeed * log(dist_sq) / this.zspace_need));
      }
    }

    const tot_force = createVector();
    if (sep_n) { tot_force.add(sep_force.div(sep_n)); }
    if (ali_n) { tot_force.add(ali_force.div(ali_n).sub(this.vel).mult(I_ALIGNMENT_FORCE.value)); }
    if (this.debugf) {
      const dpos = createVector(this.pos.x - 10, this.pos.y + 10);
      fill(0, 90, 90); draw_triangle(dpos, sep_force, sep_force.mag() * 10);
      fill(120, 90, 90); draw_triangle(dpos, ali_force, ali_force.mag() * 10);
    }

    this.vel.add(tot_force.limit(I_MAX_FORCE.value));
    if (random(1) < I_RAND_MOVE_FREQ.value) {
      this.vel.add(p5.Vector.random2D().mult(curspeed * I_RAND_MOVE_MULT.value));
    }
    const nsw = I_NATURAL_SPEED_WEIGHT.value;
    const mag = min(this.vel.mag() * (1-nsw) + this.natural_speed * nsw, this.speed_limit);
    this.vel.setMag(mag);
    this.speed_cur = lerp(this.speed_cur, mag, 1-SPEED_CUR_WEIGHT);
    this.speed_avg = lerp(this.speed_avg, mag, 1-SPEED_AVG_WEIGHT);

    this.pos.add(this.vel.copy().mult(I_SPEED_MULT.value));
    wrap_vector(this.pos);
  }
}  // Node

function create_random_flock(flock_id) {
  const flock = [];
  const c = rand_color();
  const size = rand_bound(NODE_SIZE_RANDBOUND);
  // TODO: make space_need or speed match size?
  const space_need = size * 2 * random(0.8, 1.2);
  const speed = rand_bound(SPEED_RANDBOUND);
  const pos = rand_position();
  const vel = p5.Vector.random2D().mult(speed);
  for (let i = 0; i < rand_bound(GROUP_SIZE_RANDBOUND); ++i) {
    // TODO: more principled random fuzz amount.
    const posfuzzed = p5.Vector.add(pos, p5.Vector.random2D().mult(random(space_need * 3)));
    // Note: speed set to same value.
    const velfuzzed = p5.Vector.random2D().mult(speed/3).add(vel).setMag(speed);
    flock.push(new Node(i, flock_id, posfuzzed, velfuzzed, space_need,
                        c, size * random(0.8, 1.2)));
  }
  return flock;
}

function init_node_flocks() {
  FLOCKS = [];
  for (let i = 0; i < rand_bound(NUM_GROUPS_RANDBOUND); ++i)
    FLOCKS.push(create_random_flock(i));
  update_count_displays();
}

function copy_flocks_build_quadtree(flocks) {
  const qt = new Quadtree(createVector(0,0), width, height);
  const flocks_copy = flocks.map(f => f.map(n => {
    qt.insert(n, n.pos);
    return n.copy();
  }));
  return [flocks_copy, qt];
}

function setup() {
  RAND_HUE = random(0, 360);
  frameRate(25);
  colorMode(HSB);
  createCanvas(windowWidth, windowHeight);
  create_control_panel(); setTimeout(toggle_control_panel, 1000);
  init_node_flocks();
}

function draw() {
  if (I_BACKGROUND.value) background(225, 22, 5);

  let mouse_pos = mouseIsPressed ? createVector(mouseX, mouseY) : null;
  if (touches.length > 0) {
    mouse_pos = createVector();
    for (const {x,y} of touches) {
      mouse_pos.add(createVector(x, y));
      noStroke(); fill(355, 90, 30, .5); ellipse(x, y, 40, 40);
    }
    mouse_pos.div(touches.length);
  }

  const [tmp_flocks, qt] = copy_flocks_build_quadtree(FLOCKS);
  for (const flock of FLOCKS) {
    for (const node of flock) {
      node.draw();
      node.update(tmp_flocks, qt, mouse_pos);
    }
  }

  if (mouse_pos) {
    strokeWeight(1); noFill(); let size;
    if (I_MOUSE_REPEL.value) { stroke(0, 100, 30); size = TOUCH_RAD*2; }
    else { stroke(120, 100, 20); size = TOUCH_RAD/2; }
    ellipse(mouse_pos.x, mouse_pos.y, size, size);
  }

  if (I_DEBUG_QUADTREE.value) draw_quadtree(qt, 0);
}

function draw_quadtree(tree, level) {
  strokeWeight(1);
  stroke(color(level * 55 % 360, 100, 90));
  noFill();
  rect(tree.topleft.x + level, tree.topleft.y + level,
       tree.width-level, tree.height-level);
  if (tree.nw !== null) {
    draw_quadtree(tree.nw, ++level);
    draw_quadtree(tree.ne, level);
    draw_quadtree(tree.se, level);
    draw_quadtree(tree.sw, level);
  }
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }

// Note: we need touchMoved() to return false in order for touch interactions to
// work on mobile. However, this also disables the ability to use the sliders in
// the control panel. Sooo, we toggle this value depending on whether the
// control  panel is shown.
let ALLOW_TOUCH_MOVED = false;
function touchMoved() { return ALLOW_TOUCH_MOVED; }

function touchStarted() {
  switch (touches.length) {
    case 3: I_MOUSE_REPEL.toggle(); break;
    case 4: init_node_flocks(); break;
  }
}

function keyPressed() {
  switch (key) {
    case 'p': toggle_paused(); break;
    case 'r': init_node_flocks(); break;
    case ';': toggle_control_panel(); break;
  }
}

function toggle_paused() {
  PAUSED = !PAUSED;
  if (PAUSED) { noLoop(); } else { loop(); }
}

function change_num_flocks(dir) {
  if (dir > 0) {
    FLOCKS.push(create_random_flock(FLOCKS.length));
  } else if (FLOCKS.length >= 2) {
    const to_remove = floor(random(FLOCKS.length));
    FLOCKS.splice(to_remove, 1);
    // Update flock ids for subsequent flocks to maintain invariant that array
    // index equals flock id.
    for (let i = to_remove; i < FLOCKS.length; ++i)
      for (const n of FLOCKS[i])
        n.flock_id = i;
  }
  update_count_displays();
}

function change_flock_size(dir) {
  for (const flock of FLOCKS) {
    if (dir > 0) {
      const num_to_add = max(1, int(flock.length * FLOCK_SIZE_CHANGE_FRAC));
      const orig_length = flock.length;
      for (let i = orig_length; i < orig_length + num_to_add; ++i) {
        const example = flock[int(random(flock.length))];
        const pos = example.pos.copy().add(p5.Vector.random2D().mult(example.space_need));
        const vel = example.vel.copy().rotate(random(-PI/3, PI/3));
        flock.push(new Node(i, example.flock_id, pos, vel, example.space_need, example.col, example.size));
      }
    } else {
      const target_size = max(1, int(flock.length * (1 - FLOCK_SIZE_CHANGE_FRAC)));
      flock.splice(target_size);
    }
  }
  update_count_displays();
}

let CONTROL_PANEL;
let TOGGLE_CONTROL_PANEL_BUTTON;
let NUM_FLOCKS_ELT, NUM_NODES_ELT, FRAMERATE_ELT;

function update_count_displays() {
  NUM_FLOCKS_ELT.html(`flocks [${FLOCKS.length}] `);
  NUM_NODES_ELT.html(`nodes [${FLOCKS.map(a=>a.length).reduce((a,b)=>a+b, 0)}] `);
}

function toggle_control_panel() {
  if (CONTROL_PANEL.attribute('status') === 'hidden') {
    CONTROL_PANEL.attribute('status', 'shown');
    CONTROL_PANEL.style('translate', 0, 0);
    TOGGLE_CONTROL_PANEL_BUTTON.html('hide');
    ALLOW_TOUCH_MOVED = true;
  } else {
    CONTROL_PANEL.attribute('status', 'hidden');
    const ty = CONTROL_PANEL.size()['height'] + parseInt(CONTROL_PANEL.style('bottom'), 10);
    CONTROL_PANEL.style('translate', 0, ty);
    TOGGLE_CONTROL_PANEL_BUTTON.html('show');
    ALLOW_TOUCH_MOVED = false;
  }
}

function create_control_panel() {
  CONTROL_PANEL = createDiv().id('controlPanelFull').attribute('status', 'shown');
  TOGGLE_CONTROL_PANEL_BUTTON = make_button('hide', CONTROL_PANEL, toggle_control_panel).id('showControlPanelButton');

  // Holds all the controls. Excludes the toggle button
  const main = createDiv().id('controlPanelMain').parent(CONTROL_PANEL);

  // Basic controls: pause, reinit, change speed, size, # flocks.
  const basic_controls = createDiv().parent(main);
  const br = () => createElement('br').parent(basic_controls);
  const framerate_elt = createDiv().parent(basic_controls);
  setInterval(() => framerate_elt.html(`framerate ${frameRate().toFixed(1)}`), 1000);
  make_button('reinit', basic_controls, init_node_flocks); br();
  NUM_FLOCKS_ELT = createSpan().parent(basic_controls);
  make_button('-', basic_controls, () => change_num_flocks(-1));
  make_button('+', basic_controls, () => change_num_flocks(+1));
  br();
  NUM_NODES_ELT = createSpan().parent(basic_controls);
  make_button('-', basic_controls, () => change_flock_size(-1));
  make_button('-', basic_controls, () => change_flock_size(+1));
  update_count_displays();
  I_SPEED_MULT = new NumInput('speed', 0.1, null, 1, 0.1, 32, basic_controls);
  I_ZOOM = new NumInput('size', 0.1, null, 1, 0.1, 32, basic_controls);

  // Debugging tools.
  // Purely visual options.
  I_MOUSE_REPEL = new Checkbox('mouse repel', true, basic_controls);
  I_CIRCLES = new Checkbox('circles',  false, basic_controls);
  I_BACKGROUND = new Checkbox('background', true, basic_controls);
  I_SURROUND_OR_CLOSEST = new Checkbox('better nbors',  true, basic_controls);
  I_DEBUG_NEIGHBORS = new Checkbox('debug links', false, basic_controls);
  I_DEBUG_DISTANCE = new Checkbox('debug space', false, basic_controls);
  I_DEBUG_FORCE = new Checkbox('debug force',  false, basic_controls);
  I_DEBUG_QUADTREE = new Checkbox('debug qtree', false, basic_controls);

  // Sliders for forces and such.
  const sliders = createDiv().id('sliders').parent(main);

  I_NF_SEPARATION_FORCE = new Slider('nf separation', 0, 20, 10, .5, sliders);
  I_SEPARATION_FORCE    = new Slider('separation',    0, 10, 2, .25, sliders);
  I_COHESION_FORCE      = new Slider('cohesion',      0, 10, 1, .25, sliders);
  I_ALIGNMENT_FORCE     = new Slider('alignment',     0, 10, 1, .25, sliders);

  I_MAX_FORCE            = new Slider('max force',        0, 5, .6,  .1, sliders);
  I_NATURAL_SPEED_WEIGHT = new Slider('nat speed weight', 0, 1, .2, .02, sliders);

  I_SPACE_AWARE_MULT = new Slider('space aware mult',   0, 15, 8, .5, sliders);
  I_NUM_NEIGHBORS    = new Slider('# segments (#nbrs)', 0, 16, 5, 1, sliders);
  I_NF_NUM_NEIGHBORS = new Slider('#/seg (#nf nbrs)',   0, 10, 1, 1, sliders);
  I_RAND_MOVE_FREQ = new Slider('rand move freq', 0, 1,  0, .02, sliders);
  I_RAND_MOVE_MULT = new Slider('rand move mult', 0, 1, .1, .02, sliders);
}
