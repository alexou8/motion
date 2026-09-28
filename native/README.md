# Motion keychain companion

`keychain_host.py` is a Native Messaging host named `com.motion.keychain`.
It stores only OpenAI and Anthropic API keys in the operating system vault.
The extension chooses whether to use it; the companion never contacts a
provider and never stores a key in its installation files.

Use `install.py --help` for installation arguments. The host protocol and
platform limits are documented in [../docs/keychain-companion.md](../docs/keychain-companion.md).

Run the companion tests with:

```sh
python3 -m unittest discover -s native/tests -v
```
