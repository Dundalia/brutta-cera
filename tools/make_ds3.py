"""Model a DualShock 3 shell as a smooth implicit surface and export it as GLB.

The shell is a rounded extrusion of the controller's real top-view outline (wide
wings, long grips angled slightly outwards, the narrow centre bridge, the gentle
concave front edge between the grips) with a sculpted top: domed wings, a dish
for the D-pad, shallow wells round the sticks and a front that slopes down.

Units: millimetres while modelling, metres in the file. x right, y up, z toward
the player (the grips point to +z). The shell rests on the table at y = 0.
Writes <out>.glb plus a height map of the top (<out>_height.bin/.json, mm) that
table.js uses to sit the buttons on the plastic. The GLB's COLOR_0 red channel
holds the signed height above the parting line (mm, 0.5 = on the line, +-6 mm full
range), so the material can draw the seam between the two halves.
Usage: python make_ds3.py <out.glb> [--preview <png>]
"""
import json
import os
import sys

import numpy as np
import trimesh
from scipy import ndimage
from skimage import draw, measure

out = sys.argv[1]
preview = sys.argv[sys.argv.index("--preview") + 1] if "--preview" in sys.argv else None

# --- the outline seen from above (right half, back centre to front centre) ---------------
HALF = [
    (0.0, -31.0),  # back centre: the USB port
    (14.0, -31.4),
    (28.0, -33.6),
    (44.0, -35.2),
    (57.0, -35.0),
    (67.5, -31.8),
    (73.8, -24.5),
    (76.0, -13.0),
    (76.4, 0.0),
    (76.9, 14.0),
    (77.3, 27.0),  # widest, half way down the grip
    (76.4, 39.0),
    (73.2, 48.6),
    (66.4, 54.8),  # grip tip
    (58.6, 54.8),
    (52.6, 50.2),
    (48.6, 42.0),
    (45.0, 34.4),
    (40.6, 30.2),  # the armpit between grip and centre
    (33.6, 31.0),
    (23.5, 32.4),  # under the stick
    (12.5, 27.4),
    (0.0, 24.4),  # front centre
]


def catmull_rom(points, samples=24):
    """Closed centripetal Catmull-Rom curve through the points."""
    p = np.asarray(points, float)
    n = len(p)
    res = []
    for i in range(n):
        p0, p1, p2, p3 = p[i - 1], p[i], p[(i + 1) % n], p[(i + 2) % n]
        t0 = 0.0
        t1 = t0 + np.linalg.norm(p1 - p0) ** 0.5
        t2 = t1 + np.linalg.norm(p2 - p1) ** 0.5
        t3 = t2 + np.linalg.norm(p3 - p2) ** 0.5
        for t in np.linspace(t1, t2, samples, endpoint=False):
            a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
            b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
            res.append((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2)
    return np.array(res)


loop = HALF + [(-x, z) for x, z in reversed(HALF[1:-1])]
outline = catmull_rom(loop)

# signed distance to the outline (mm, negative inside), from a fine raster
FINE = 0.1
fx = np.arange(-90, 90 + FINE, FINE)
fz = np.arange(-50, 70 + FINE, FINE)
mask = np.zeros((len(fx), len(fz)), bool)
rr, cc = draw.polygon((outline[:, 0] - fx[0]) / FINE, (outline[:, 1] - fz[0]) / FINE, mask.shape)
mask[rr, cc] = True
sd_fine = (ndimage.distance_transform_edt(~mask) - ndimage.distance_transform_edt(mask)) * FINE

VOX = 0.6
xs = np.arange(-84, 84 + VOX, VOX)
ys = np.arange(-4, 40 + VOX, VOX)
zs = np.arange(-44, 64 + VOX, VOX)
GX, GZ = np.meshgrid(xs, zs, indexing="ij")
d2 = ndimage.map_coordinates(sd_fine, [(GX - fx[0]) / FINE, (GZ - fz[0]) / FINE], order=1)


# --- the top surface: height (mm) and edge rounding over the plan ----------------------
def gauss(dx, dz, s):
    return np.exp(-(dx * dx + dz * dz) / (2 * s * s))


def smoothstep(a, b, v):
    t = np.clip((v - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def bowl(cx, cz, r, depth):
    q = np.clip(1 - ((GX - cx) ** 2 + (GZ - cz) ** 2) / (r * r), 0, 1)
    return depth * q * q


AX = np.abs(GX)
# grips: distance along / across the axis from the wing to the tip
g0 = np.array([52.0, 2.0])
g1 = np.array([61.0, 44.0])
gd = (g1 - g0) / np.linalg.norm(g1 - g0)
along = (AX - g0[0]) * gd[0] + (GZ - g0[1]) * gd[1]
grip_t = np.clip(along / np.linalg.norm(g1 - g0), 0, 1)
grip_w = smoothstep(8, 26, GZ) * smoothstep(34, 46, AX)

H = np.full_like(GX, 25.6)
H += 3.6 * gauss(AX - 46, GZ + 5, 24)  # the wings rise under D-pad and face buttons
H += 1.2 * smoothstep(-20, -34, GZ) * smoothstep(20, 40, AX)  # shoulders over L1/L2
H -= 4.6 * smoothstep(6, 30, GZ) * (1 - smoothstep(30, 44, AX))  # the centre slopes to the front
H = H * (1 - grip_w) + (28.4 - 4.2 * grip_t) * grip_w  # the grips fall towards their tips
H -= bowl(-46, -5, 18.5, 2.4)  # the D-pad dish
H -= bowl(46, -5, 21, 0.9)  # the face buttons sit in a shallower one
for s in (-1, 1):
    H -= bowl(s * 23, 17, 15.5, 1.9)  # wells round the sticks
H -= bowl(0, 9, 8.5, 0.6)  # PS button

R = np.full_like(GX, 9.0)
R = R * (1 - grip_w) + 12.6 * grip_w
R -= 1.6 * smoothstep(-22, -33, GZ)
R = np.minimum(R, H / 2 - 0.4)

# rounded extrusion between y = 0 and y = H
Y3 = ys[None, :, None]
C = (H / 2)[:, None, :]
HH = (H / 2)[:, None, :]
RR = R[:, None, :]
wx = d2[:, None, :] + RR
wy = np.abs(Y3 - C) - HH + RR
d = np.minimum(np.maximum(wx, wy), 0) + np.sqrt(np.maximum(wx, 0) ** 2 + np.maximum(wy, 0) ** 2) - RR
d = np.maximum(d, -(Y3 - 0.5))  # a small flat where it sits on the table
d = d.astype(np.float32)


def top_height(d, shift=0.0):
    """Height (mm) of the top surface over the plan, interpolated between voxels."""
    inside = d < 0
    has = inside.any(1)
    j = len(ys) - 1 - np.argmax(inside[:, ::-1, :], axis=1)
    jn = np.minimum(j + 1, len(ys) - 1)
    d0 = np.take_along_axis(d, j[:, None, :], 1)[:, 0, :]
    d1 = np.take_along_axis(d, jn[:, None, :], 1)[:, 0, :]
    frac = np.where(jn > j, d0 / np.where(d0 - d1 == 0, -1, d0 - d1), 0)
    return np.where(has, ys[j] + VOX * frac - shift, np.nan).astype(np.float32)


if preview:
    from PIL import Image

    top = top_height(d)
    gx, gz = np.gradient(np.nan_to_num(top, nan=0), VOX)
    light = np.array([-0.5, 1.0, -0.6])
    light /= np.linalg.norm(light)
    n = np.stack([-gx, np.ones_like(gx), -gz])
    n /= np.linalg.norm(n, axis=0)
    shade = np.clip((n * light[:, None, None]).sum(0), 0, 1) ** 2
    img = np.where(np.isnan(top), 0.55, 0.08 + 0.85 * shade)
    # contour every 2 mm
    img = np.where(np.abs((np.nan_to_num(top) + 1) % 2 - 1) < 0.08, img * 0.6, img)
    Image.fromarray((img.T * 255).astype(np.uint8)).resize((len(xs) * 3, len(zs) * 3), Image.BILINEAR).save(preview)
    print("preview", preview, "top max", np.nanmax(top))
    sys.exit(0)

verts, faces, normals, _ = measure.marching_cubes(d, level=0, spacing=(VOX, VOX, VOX))
verts += np.array([xs[0], ys[0], zs[0]])
mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
# marching cubes leaves a few zero-area slivers as loose faces: keep the one clean surface
mesh.update_faces(mesh.nondegenerate_faces(height=1e-6))
mesh = max(mesh.split(only_watertight=False), key=lambda m: len(m.faces))
mesh.remove_unreferenced_vertices()
trimesh.smoothing.filter_taubin(mesh, lamb=0.5, nu=-0.53, iterations=10)
shift = mesh.vertices[:, 1].min()
mesh.vertices[:, 1] -= shift

# Height map of the top surface (mm), so buttons and decals can follow the plastic.
top = np.nan_to_num(top_height(d, shift), nan=0.0)
base = os.path.splitext(out)[0]
top.astype("<f4").tofile(base + "_height.bin")
json.dump({"x0": float(xs[0]), "z0": float(zs[0]), "step": VOX, "nx": len(xs), "nz": len(zs)}, open(base + "_height.json", "w"))
print("bounds mm:", mesh.bounds.round(1).tolist(), "faces:", len(mesh.faces))

mesh = mesh.simplify_quadric_decimation(face_count=20000)
print("after decimation:", len(mesh.faces))


def field(points):
    """The distance field (mm) at points in the shifted frame of the mesh."""
    return ndimage.map_coordinates(d, [(points[:, 0] - xs[0]) / VOX, (points[:, 1] + shift - ys[0]) / VOX, (points[:, 2] - zs[0]) / VOX], order=1, mode="nearest")


# how far the decimated surface strays from the field
tri = mesh.vertices[mesh.faces]
samples = np.concatenate([tri.mean(1), (tri[:, 0] + tri[:, 1]) / 2, (tri[:, 1] + tri[:, 2]) / 2, (tri[:, 2] + tri[:, 0]) / 2])
err = field(samples)
print("surface error mm: max out %.2f, max in %.2f, faces off by > 0.4 mm: %d" % (err.max(), -err.min(), int((np.abs(err) > 0.4).sum())))

# parting line: half way up the local thickness
v = mesh.vertices
mid = ndimage.map_coordinates(H / 2, [(v[:, 0] - xs[0]) / VOX, (v[:, 2] - zs[0]) / VOX], order=1, mode="nearest") - shift
seam = np.clip((v[:, 1] - mid) / 12 + 0.5, 0, 1)
colors = np.zeros((len(v), 4), np.uint8)
colors[:, 0] = np.round(seam * 255)
colors[:, 3] = 255
mesh.visual = trimesh.visual.ColorVisuals(mesh, vertex_colors=colors)

# smooth normals straight from the field, so highlights do not show the triangles
grad = np.stack(np.gradient(d, VOX))
gv = np.stack([ndimage.map_coordinates(g, [(v[:, 0] - xs[0]) / VOX, (v[:, 1] + shift - ys[0]) / VOX, (v[:, 2] - zs[0]) / VOX], order=1) for g in grad], 1)
normals = gv / np.linalg.norm(gv, axis=1, keepdims=True)
mesh.vertices /= 1000.0
mesh.vertex_normals = normals
with open(out, "wb") as f:
    f.write(trimesh.exchange.gltf.export_glb(trimesh.Scene(mesh), include_normals=True))
print("glb bytes:", os.path.getsize(out))
