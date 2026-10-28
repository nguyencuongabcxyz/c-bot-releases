//! The stage's grid: how the screen is shared out into tiles, the gaps between them, and how
//! dragging a gap or a tile changes it (pure geometry, no windows).

use super::*;

// ---------------------------------------------------------------- the grid

/// `total` px shared out by weight (the last one takes what rounding left over).
pub(super) fn split_px(total: i32, weights: &[f64]) -> Vec<i32> {
    let sum = weights.iter().sum::<f64>().max(1e-9);
    let mut used = 0;
    weights
        .iter()
        .enumerate()
        .map(|(i, w)| {
            let v = if i + 1 == weights.len() {
                total - used
            } else {
                (total as f64 * w / sum).round() as i32
            };
            used += v;
            v
        })
        .collect()
}

/// The gap after item k moved by d px: the item on the side it moved away from grows, and
/// the ones on the other side give way, the nearest first, each down to min.
pub(super) fn give(sizes: &[i32], k: usize, d: i32, min: i32) -> Vec<i32> {
    let mut s = sizes.to_vec();
    if k + 1 >= s.len() || d == 0 {
        return s;
    }
    let (grow, takers): (usize, Vec<usize>) = if d > 0 {
        (k, (k + 1..s.len()).collect())
    } else {
        (k + 1, (0..=k).rev().collect())
    };
    let need = d.abs();
    let mut got = 0;
    for j in takers {
        let can = (s[j] - min).max(0).min(need - got);
        s[j] -= can;
        got += can;
        if got == need {
            break;
        }
    }
    s[grow] += got;
    s
}

/// How a cast of robots first shares the screen (CSS px of room): two side by side, three
/// one big and two stacked (all three side by side on a very wide screen), four and more in
/// rows, the first rows taking any odd one out; never narrower than a chat can be.
pub(super) fn arrange(ids: &[String], w: f64, h: f64) -> (bool, Vec<Group>) {
    let n = ids.len();
    let fit = ((w / MIN_W).floor() as usize).max(1);
    let group = |ids: &[String]| Group {
        w: 1.0,
        tiles: ids
            .iter()
            .map(|id| Tile {
                id: id.clone(),
                w: 1.0,
            })
            .collect(),
    };
    let cols = |chunks: Vec<&[String]>| (false, chunks.into_iter().map(group).collect());
    match n {
        0 => (false, vec![]),
        1 => cols(vec![ids]),
        2 if fit >= 2 => cols(vec![&ids[..1], &ids[1..]]),
        3 if fit >= 3 && w / h > 2.2 => cols(vec![&ids[..1], &ids[1..2], &ids[2..]]),
        3 if fit >= 2 => cols(vec![&ids[..1], &ids[1..]]),
        _ if fit == 1 => cols(vec![ids]),
        _ => {
            let rows = ((n as f64).sqrt().round() as usize)
                .max(n.div_ceil(fit))
                .max(1);
            let (base, extra) = (n / rows, n % rows);
            let mut at = 0;
            let groups = (0..rows)
                .map(|r| {
                    let len = base + usize::from(r < extra);
                    let g = group(&ids[at..at + len]);
                    at += len;
                    g
                })
                .filter(|g| !g.tiles.is_empty())
                .collect();
            (true, groups)
        }
    }
}

impl Stage {
    pub(super) fn cast(&self) -> Vec<String> {
        self.groups
            .iter()
            .flat_map(|g| g.tiles.iter().map(|t| t.id.clone()))
            .collect()
    }

    pub(super) fn has(&self, id: &str) -> bool {
        self.groups
            .iter()
            .any(|g| g.tiles.iter().any(|t| t.id == id))
    }

    pub(super) fn px(&self, css: f64) -> i32 {
        (css * self.scale).round() as i32
    }

    /// Where the tiles go: the screen less the bar along its bottom.
    pub(super) fn area(&self) -> Rect {
        let bar = self.px(BAR_H);
        Rect {
            x: self.screen.x,
            y: self.screen.y,
            w: self.screen.w,
            h: self.screen.h - bar,
        }
    }

    pub(super) fn bar_rect(&self) -> Rect {
        let bar = self.px(BAR_H);
        Rect {
            x: self.screen.x,
            y: self.screen.bottom() - bar,
            w: self.screen.w,
            h: bar,
        }
    }

    pub(super) fn pill_rect(&self) -> Rect {
        let (w, h) = (self.px(PILL.0).min(self.screen.w), self.px(PILL.1));
        Rect {
            x: self.screen.x + (self.screen.w - w) / 2,
            y: self.screen.bottom() - h - self.px(16.0),
            w,
            h,
        }
    }

    pub(super) fn arrange(&mut self, ids: &[String]) {
        let a = self.area();
        let (rows, groups) = arrange(ids, a.w as f64 / self.scale, a.h as f64 / self.scale);
        self.rows = rows;
        self.groups = groups;
    }

    /// The most robots that fit on the screen.
    pub(super) fn room(&self) -> usize {
        let a = self.area();
        let fit = ((a.w as f64 / self.scale / MIN_W).floor() as usize).max(1);
        let rows = ((a.h as f64 / self.scale / MIN_H).floor() as usize).clamp(1, MAX_ROWS);
        fit * rows
    }

    /// Each robot's window on the stage, and what its page needs to know about its tile
    /// (which of its edges are gaps you can drag, and which gap; or that it's in the
    /// spotlight, or a strip beside it).
    pub(super) fn placements(&self) -> Vec<Placed> {
        let a = self.area();
        let cast = self.cast();
        let mut out = vec![];
        if let Some(spot) = self
            .spot
            .as_ref()
            .filter(|s| cast.len() > 1 && cast.contains(s))
        {
            let sw = self.px(STRIP_W).min(a.w / 3);
            out.push(Placed {
                id: spot.clone(),
                rect: Rect {
                    x: a.x,
                    y: a.y,
                    w: a.w - sw,
                    h: a.h,
                },
                info: json!({ "spot": true }),
            });
            let others: Vec<&String> = cast.iter().filter(|c| *c != spot).collect();
            let mut y = a.y;
            for (id, h) in others.iter().zip(split_px(a.h, &vec![1.0; others.len()])) {
                out.push(Placed {
                    id: (*id).clone(),
                    rect: Rect {
                        x: a.right() - sw,
                        y,
                        w: sw,
                        h,
                    },
                    info: json!({ "strip": true }),
                });
                y += h;
            }
            return out;
        }
        let (outer, inner) = if self.rows { (a.h, a.w) } else { (a.w, a.h) };
        let ng = self.groups.len();
        let mut o = 0;
        for (gi, (g, gsz)) in self
            .groups
            .iter()
            .zip(split_px(
                outer,
                &self.groups.iter().map(|g| g.w).collect::<Vec<_>>(),
            ))
            .enumerate()
        {
            let nt = g.tiles.len();
            let mut i = 0;
            for (ti, (t, tsz)) in g
                .tiles
                .iter()
                .zip(split_px(
                    inner,
                    &g.tiles.iter().map(|t| t.w).collect::<Vec<_>>(),
                ))
                .enumerate()
            {
                let rect = if self.rows {
                    Rect {
                        x: a.x + i,
                        y: a.y + o,
                        w: tsz,
                        h: gsz,
                    }
                } else {
                    Rect {
                        x: a.x + o,
                        y: a.y + i,
                        w: gsz,
                        h: tsz,
                    }
                };
                let before_o = (gi > 0).then(|| Split::Outer(gi - 1).name());
                let after_o = (gi + 1 < ng).then(|| Split::Outer(gi).name());
                let before_i = (ti > 0).then(|| Split::Inner(gi, ti - 1).name());
                let after_i = (ti + 1 < nt).then(|| Split::Inner(gi, ti).name());
                let (left, right, top, bottom) = if self.rows {
                    (before_i, after_i, before_o, after_o)
                } else {
                    (before_o, after_o, before_i, after_i)
                };
                out.push(Placed { id: t.id.clone(), rect, info: json!({ "edges": { "left": left, "right": right, "top": top, "bottom": bottom } }) });
                i += tsz;
            }
            o += gsz;
        }
        out
    }

    /// The sizes along a gap's axis (physical px), and whether that axis is across.
    pub(super) fn sizes_of(&self, split: Split) -> Option<(Vec<i32>, bool)> {
        let a = self.area();
        let (outer, inner) = if self.rows { (a.h, a.w) } else { (a.w, a.h) };
        match split {
            Split::Outer(k) if k + 1 < self.groups.len() => Some((
                split_px(outer, &self.groups.iter().map(|g| g.w).collect::<Vec<_>>()),
                !self.rows,
            )),
            Split::Inner(g, k) => {
                let tiles = &self.groups.get(g)?.tiles;
                (k + 1 < tiles.len()).then(|| {
                    (
                        split_px(inner, &tiles.iter().map(|t| t.w).collect::<Vec<_>>()),
                        self.rows,
                    )
                })
            }
            _ => None,
        }
    }

    pub(super) fn set_weights(&mut self, split: Split, sizes: &[i32]) {
        let ws = sizes.iter().map(|&v| v.max(1) as f64);
        match split {
            Split::Outer(_) => self.groups.iter_mut().zip(ws).for_each(|(g, w)| g.w = w),
            Split::Inner(g, _) => {
                if let Some(g) = self.groups.get_mut(g) {
                    g.tiles.iter_mut().zip(ws).for_each(|(t, w)| t.w = w);
                }
            }
        }
    }

    /// Out of the grid (its group goes too, once empty).
    pub(super) fn remove(&mut self, id: &str) -> bool {
        let before = self.cast().len();
        for g in &mut self.groups {
            g.tiles.retain(|t| t.id != id);
        }
        self.groups.retain(|g| !g.tiles.is_empty());
        if self.spot.as_deref() == Some(id) {
            self.spot = None;
        }
        self.cast().len() != before
    }
}
