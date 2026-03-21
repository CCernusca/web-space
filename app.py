from flask import Flask, render_template, jsonify

app = Flask(__name__)

# Block type registry.
# "properties" describes the type (sent to client, cached in localStorage).
# "data" holds default values for per-instance mutable fields (health only for now).
# maxHealth lives in properties (type-level constant); health lives in data (instance state).
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
            "shapes": "r:0:0:1:1:0:0.24:0.63:0.78,c:0.5:0.5:0.3:0:0.6:0.88:1.0",
            "maxHealth": 800,
            "mass": 3,
        },
        "data": {
            "health": 800,
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
