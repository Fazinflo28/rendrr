"""Scene cuts with PySceneDetect's ContentDetector. Prints a JSON list of cut times in seconds."""
import json
import sys

from scenedetect import ContentDetector, SceneManager, open_video


def main(path: str, threshold: float = 27.0) -> None:
    video = open_video(path)
    manager = SceneManager()
    manager.auto_downscale = True
    manager.add_detector(ContentDetector(threshold=threshold, min_scene_len=15))
    manager.detect_scenes(video, show_progress=False)
    scenes = manager.get_scene_list()
    cuts = [round(getattr(start, "seconds", None) if not callable(getattr(start, "seconds", None)) and getattr(start, "seconds", None) is not None else start.get_seconds(), 2) for start, _ in scenes[1:]]
    print(json.dumps(cuts))


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 27.0)
