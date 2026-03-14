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
            "maxHealth": 50,
            "mass": 5,
        },
        "data": {
            "health": 50,
        },
    },
    "hull_heavy": {
        "properties": {
            "id": "hull_heavy",
            "size": {"x": 2, "y": 1},
            "color": {"r": 55, "g": 75, "b": 110},
            "maxHealth": 150,
            "mass": 15,
        },
        "data": {
            "health": 150,
        },
    },
    "armor_plate": {
        "properties": {
            "id": "armor_plate",
            "size": {"x": 1, "y": 2},
            "color": {"r": 95, "g": 110, "b": 135},
            "maxHealth": 200,
            "mass": 20,
        },
        "data": {
            "health": 200,
        },
    },
    "cockpit": {
        "properties": {
            "id": "cockpit",
            "size": {"x": 1, "y": 1},
            "color": {"r": 60, "g": 160, "b": 200},
            "maxHealth": 80,
            "mass": 3,
        },
        "data": {
            "health": 80,
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
