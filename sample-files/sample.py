"""Sample Python file for testing the file inspector sidebar."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Callable


@dataclass
class Point:
    """A 2D point with basic arithmetic."""

    x: float
    y: float

    def distance_to(self, other: "Point") -> float:
        return math.hypot(self.x - other.x, self.y - other.y)

    def __add__(self, other: "Point") -> "Point":
        return Point(self.x + other.x, self.y + other.y)


def clamp(value: float, low: float, high: float) -> float:
    """Clamp a value into the inclusive range [low, high]."""
    return max(low, min(high, value))


def random_points(n: int, seed: int | None = None) -> list[Point]:
    """Generate n random points within the unit square."""
    rng = random.Random(seed)
    return [Point(rng.random(), rng.random()) for _ in range(n)]


def nearest_neighbor(origin: Point, points: list[Point]) -> Point:
    """Return the point closest to origin."""
    return min(points, key=lambda p: p.distance_to(origin))


def summarize(points: list[Point], formatter: Callable[[float], str] = str) -> dict[str, str]:
    """Compute a small summary of a point cloud."""
    xs = [p.x for p in points]
    ys = [p.y for p in points]
    return {
        "count": str(len(points)),
        "min_x": formatter(min(xs)),
        "max_x": formatter(max(xs)),
        "min_y": formatter(min(ys)),
        "max_y": formatter(max(ys)),
    }


def main() -> None:
    pts = random_points(5, seed=42)
    print("Generated points:")
    for p in pts:
        print(f"  {p.x:.3f}, {p.y:.3f}")
    print(summarize(pts))


if __name__ == "__main__":
    main()
