import unittest

from agent import validate_action


class PolicyTests(unittest.TestCase):
    def test_accepts_known_command(self):
        action = validate_action({"kind": "windows", "command": "list-windows"})
        self.assertEqual(action["command"], "list-windows")

    def test_rejects_shell_command(self):
        with self.assertRaises(ValueError):
            validate_action({"kind": "windows", "command": "shell"})

    def test_rejects_extra_fields(self):
        with self.assertRaises(ValueError):
            validate_action({"kind": "windows", "command": "click", "script": "bad"})


if __name__ == "__main__":
    unittest.main()
