import json
import tempfile
import unittest
from pathlib import Path

from lumen_local.ingest import ingest_capture


class IngestTests(unittest.TestCase):
    def test_same_filename_in_two_captures_never_overwrites(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            root = Path(temporary)
            first = root / "card1"
            second = root / "card2"
            destination = root / "archive"
            first.mkdir()
            second.mkdir()
            (first / "C001.MP4").write_bytes(b"first take")
            (second / "C001.MP4").write_bytes(b"second take")

            capture_a = ingest_capture(first, destination, "company-a", "Shopping")
            capture_b = ingest_capture(second, destination, "company-a", "Praia")
            self.assertEqual(capture_a["verified_count"], 1)
            self.assertEqual(capture_b["verified_count"], 1)
            self.assertNotEqual(capture_a["capture_id"], capture_b["capture_id"])
            copied_a = Path(capture_a["manifest_path"]).parent / capture_a["assets"][0]["copy_relative_path"]
            copied_b = Path(capture_b["manifest_path"]).parent / capture_b["assets"][0]["copy_relative_path"]
            self.assertEqual(copied_a.read_bytes(), b"first take")
            self.assertEqual(copied_b.read_bytes(), b"second take")
            self.assertEqual((first / "C001.MP4").read_bytes(), b"first take")

    def test_workspace_isolation_in_destination_paths(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            root = Path(temporary)
            source = root / "card"
            source.mkdir()
            (source / "C001.MP4").write_bytes(b"test")
            a = ingest_capture(source, root / "archive", "client-a", "One")
            b = ingest_capture(source, root / "archive", "client-b", "Two")
            self.assertIn("client-a", Path(a["manifest_path"]).parts)
            self.assertIn("client-b", Path(b["manifest_path"]).parts)
            self.assertEqual(json.loads(Path(a["manifest_path"]).read_text(encoding="utf-8"))["workspace_id"], "client-a")

    def test_refuses_nested_destination_and_bad_workspace(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            root = Path(temporary)
            source = root / "card"
            source.mkdir()
            (source / "C001.MP4").write_bytes(b"test")
            with self.assertRaises(ValueError):
                ingest_capture(source, source / "archive", "safe", "Test")
            with self.assertRaises(ValueError):
                ingest_capture(source, root / "archive", "../escape", "Test")


if __name__ == "__main__":
    unittest.main()
