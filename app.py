from flask import Flask, render_template, jsonify

app = Flask(__name__)

# Block type registry.
# "properties" describes the type (sent to client, cached in localStorage).
# "data" holds default values for per-instance mutable fields (health only for now).
# maxHealth lives in properties (type-level constant); health lives in data (instance state).
# Shape format: "<id>:<expr>:<expr>:..." where coordinates/sizes are in tiles (1=one tile)
# and colors are in 0–1 range.  Each parameter may be a plain number or a math expression
# (evaluated each render cycle).
# Available functions/constants: sin cos tan abs sqrt pow log floor ceil round min max PI E
# Available operators:  + - * / % (modulo) ** (exponent)
# Available variables:  t (seconds since page load)  h (health/maxHealth, 0–1)
#                       x y (tile-unit position of current pixel within block, color fields only;
#                            resolves to 0 in position/size fields)
# Supported shapes:
#   r:x:y:w:h:rot:cr:cg:cb[:ca]  — filled rectangle
#   c:cx:cy:radius:rot:cr:cg:cb[:ca] — filled circle
# rot is 0–1 (0=0°, 0.5=180°, 1=360°); any value is modulo'd into range.
# Alpha (ca) is optional and defaults to 1.
# When x or y are used in color fields, shapes are rendered pixel-by-pixel (slow path).
# 
# PERFORMANCE WARNING: using x, y, t, or h in color fields triggers a per-pixel
# slow path (OffscreenCanvas pixel loop) instead of a single fillRect/arc call.
# This runs in JS for every pixel of every affected shape every frame. Use
# sparingly — large shapes, many blocks, or high display DPI will tank frame rate.
BLOCK_REGISTRY = {
    "hull_light": {
        "properties": {
            "id": "hull_light",
            "size": {"x": 1, "y": 1},
            "color": {"r": 80, "g": 105, "b": 150},
            "shapes": "r:0:0:1:1:0:0.31:0.41:0.59,r:0.08:0.08:0.84:0.84:0:0.38:0.49:0.67",
            "maxHealth": 500,
            "mass": 5,
        },
        "data": {
            "health": 500,
        },
    },
    "hull_heavy": {
        "properties": {
            "id": "hull_heavy",
            "size": {"x": 2, "y": 1},
            "color": {"r": 55, "g": 75, "b": 110},
            "shapes": "r:0:0:2:1:0:0.22:0.29:0.43,r:0.08:0.08:1.84:0.84:0:0.27:0.35:0.52",
            "maxHealth": 1500,
            "mass": 15,
        },
        "data": {
            "health": 1500,
        },
    },
    "armor_plate": {
        "properties": {
            "id": "armor_plate",
            "size": {"x": 1, "y": 2},
            "color": {"r": 95, "g": 110, "b": 135},
            "shapes": "r:0:0:1:2:0:0.37:0.43:0.53,r:0.08:0.08:0.84:1.84:0:0.44:0.51:0.61,r:0.25:0.75:0.5:0.5:0:0.5:0.58:0.69",
            "maxHealth": 2000,
            "mass": 20,
        },
        "data": {
            "health": 2000,
        },
    },
    "cockpit": {
        "properties": {
            "id": "cockpit",
            "size": {"x": 1, "y": 1},
            "color": {"r": 60, "g": 160, "b": 200},
            "shapes": "r:0:0:1:1:0.05*(1-h):0.24:0.63:0.78,c:0.5:0.5:0.3:0:0.6:0.88:1.0",
            "maxHealth": 800,
            "mass": 3,
        },
        "data": {
            "health": 800,
        },
    },
    "cannon": {
        "properties": {
            "id": "cannon",
            "size": {"x": 1, "y": 1},
            "color": {"r": 160, "g": 110, "b": 55},
            # Dark base, lower body, barrel pointing up (toward ty-1 in editor)
            "shapes": "r:0:0:1:1:0:0.22:0.18:0.12,r:0.1:0.45:0.8:0.5:0:0.5:0.38:0.2,r:0.33:0:0.34:0.5:0:0.6:0.44:0.22",
            "maxHealth": 600,
            "mass": 8,
            "deathExplosion": 5000,
            "projectile": {
                "speed": 10,
                "impactDamage": 1000,
                "pierce": 0.5,
                "explosionStrength": 1000,
                "lifetime": 3,
                "shapeStr": "r:-0.375:-0.1:0.75:0.2:0:1:1:0:1",
                "spawnerKey": "white_glow",
                "particleInterval": 0.1,
                "blowback": 80,
            },
        },
        "data": {
            "health": 600,
        },
    },
}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/block-registry")
def block_registry():
    return jsonify(BLOCK_REGISTRY)


if __name__ == "__main__":
    app.run(debug=True)
