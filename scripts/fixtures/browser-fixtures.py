#!/usr/bin/env python3
"""Generate HAEVN export ZIP fixtures for the browser walk (HVN-56, 20, 51, 33, 40/50, 54, 60-62, 65).

Usage: python3 scripts/fixtures/browser-fixtures.py [N_FILLER=300] [OUT_DIR]

Outputs (in transcripts/browser-check/ by default):
  fixtures.zip   - HAEVN export ZIP: special test chats + N filler chats, some with PNG images
  late_chat.json - one chat (unique word "kumquatine") to save during a rebuild (HVN-54)
"""
import json, os, random, struct, sys, zipfile, zlib, uuid, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
# The browser tools upload only files inside the working tree, so the default is the gitignored
# transcripts/ of the repository (or worktree) this script sits in. A second argument overrides it.
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "..", "transcripts", "browser-check")
os.makedirs(OUT, exist_ok=True)
N_FILLER = int(sys.argv[1]) if len(sys.argv) > 1 else 300
rng = random.Random(20261118)
BASE_TS = 1793000000000  # ms

VOCAB = """the archive keeps every conversation with its branches and context so a reader can return
to an argument months later and find the reply that mattered most we talked about compilers gardens
weather trains bread rivers ledgers lanterns harbours sailing mountains libraries paper printing ink
type margins columns tables indexes search engines tokens memory latency bandwidth caches queues
workers threads locks schedules calendars deadlines budgets invoices letters stamps parcels routes
maps compasses bridges tunnels roads cities villages forests meadows orchards vineyards kitchens
recipes soup salt pepper garlic onions tomatoes lemons honey tea coffee milk sugar flour yeast oven
temperature pressure gauge valve pipe pump engine motor gear wheel axle spring lever pulley rope
knot sail anchor deck hull keel mast tide current wave shore cliff island lighthouse beacon signal
radio antenna wire circuit resistor capacitor diode transistor voltage ampere ohm watt battery
charge plan draft review revision chapter verse poem essay novel story myth legend saga epic hero
journey threshold mentor trial return question answer reason evidence claim premise conclusion
proof lemma theorem axiom function variable constant integer fraction ratio matrix vector tensor
gradient descent loss model training data sample batch epoch layer neuron weight bias activation
""".split()

FORBIDDEN = {"pineapple", "zanzibarite", "quokka", "marmalade", "xylophonist", "branchalpha",
             "branchbravo", "branchcharlie", "forkdelta", "forkecho", "dodecahedron", "kumquatine"}
assert not FORBIDDEN & set(VOCAB)


def words(n):
    out = []
    for i in range(n):
        w = rng.choice(VOCAB)
        if i % 14 == 0:
            w = w.capitalize()
        out.append(w)
        if i % 14 == 13:
            out[-1] += "."
    return " ".join(out) + "."


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def req(text_or_parts, ts):
    return {"kind": "request", "parts": [{"part_kind": "user-prompt", "content": text_or_parts, "timestamp": iso(ts)}]}


def resp(text, ts):
    return {"kind": "response", "parts": [{"part_kind": "text", "content": text}], "model_name": "claude-fixture", "timestamp": iso(ts)}


class ChatBuilder:
    def __init__(self, chat_id, title, ts):
        self.id, self.title, self.ts = chat_id, title, ts
        self.messages = {}
        self.n = 0

    def add(self, mid, parent, role, content):
        self.n += 1
        ts = self.ts + self.n * 60000
        m = {"id": mid, "parentId": parent, "childrenIds": [], "message": [req(content, ts) if role == "user" else resp(content, ts)],
             "model": "claude-fixture", "done": True, "timestamp": ts, "chatId": self.id}
        if parent is None:
            del m["parentId"]
        else:
            self.messages[parent]["childrenIds"].append(mid)
        self.messages[mid] = m
        return mid

    def linear(self, turns):
        parent = None
        for i, (role, content) in enumerate(turns):
            parent = self.add(f"{self.id}-m{i}", parent, role, content)
        return parent

    def chat(self, current_id):
        return {"id": self.id, "source": "claude", "sourceId": self.id, "title": self.title, "models": ["claude-fixture"],
                "params": {}, "currentId": current_id, "messages": self.messages, "tags": [], "timestamp": self.ts,
                "lastSyncedTimestamp": self.ts + 3600000, "checksum": "", "syncStatus": "synced", "deleted": 0}


def png(w, h, rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


chats, media = [], []  # media: (path, chatId, messageId, partIndex, bytes)
ts = BASE_TS

# HVN-56: hostile markup next to "pineapple"
b = ChatBuilder("fx-xss", "Fixture XSS pineapple", ts)
last = b.linear([
    ("user", 'My pineapple note: <img src=x onerror="window.__pwned=1"> and <script>window.__pwned2=1</script> end of pineapple test.'),
    ("assistant", 'Echo of the pineapple markup: <img src=x onerror="window.__pwned3=1"> <script>window.__pwned4=1</script> and `<b>code</b>`.'),
])
chats.append(b.chat(last))

# HVN-20 (a): a match deep in a long message (~2400 words, match at ~word 1800)
b = ChatBuilder("fx-deep", "Fixture deep match", ts + 1000)
long_text = words(1800) + " The zanzibarite sample sits deep in this message. " + words(600)
last = b.linear([("user", long_text), ("assistant", words(80))])
chats.append(b.chat(last))

# HVN-20 (b): several matches inside one window
b = ChatBuilder("fx-window", "Fixture many in one window", ts + 2000)
txt = words(300) + " A quokka met a second quokka, and then a third quokka joined them. " + words(300)
last = b.linear([("user", txt), ("assistant", words(60))])
chats.append(b.chat(last))

# HVN-20 (c): far-apart matches -> up to three passages
b = ChatBuilder("fx-far", "Fixture far apart matches", ts + 3000)
txt = (words(200) + " First marmalade here. " + words(500) + " Second marmalade there. " + words(500)
       + " Third marmalade elsewhere. " + words(500) + " Fourth marmalade at the end. " + words(100))
last = b.linear([("user", txt), ("assistant", words(60))])
chats.append(b.chat(last))

# HVN-20 (d): match only in an assistant reply
b = ChatBuilder("fx-assistant", "Fixture assistant only", ts + 4000)
last = b.linear([("user", words(40)), ("assistant", words(50) + " Ask the xylophonist about it. " + words(50))])
chats.append(b.chat(last))

# HVN-51: forked chat, currentId on a later branch at two forks
b = ChatBuilder("fx-fork", "Fixture forked chat", ts + 5000)
u1 = b.add("fx-fork-u1", None, "user", "Root question about forks. " + words(20))
a1 = b.add("fx-fork-a1", u1, "assistant", "Root answer. " + words(20))
u2a = b.add("fx-fork-u2a", a1, "user", "branchalpha user turn, the first child. " + words(10))
a2a = b.add("fx-fork-a2a", u2a, "assistant", "branchalpha answer. " + words(10))
u2b = b.add("fx-fork-u2b", a1, "user", "branchbravo user turn, the second child. " + words(10))
a2b = b.add("fx-fork-a2b", u2b, "assistant", "branchbravo answer. " + words(10))
u2c = b.add("fx-fork-u2c", a1, "user", "branchcharlie user turn, the third child. " + words(10))
a2c = b.add("fx-fork-a2c", u2c, "assistant", "branchcharlie answer, a side branch. " + words(10))
u3d = b.add("fx-fork-u3d", a2b, "user", "forkdelta user turn, first child at the second fork. " + words(10))
a3d = b.add("fx-fork-a3d", u3d, "assistant", "forkdelta answer. " + words(10))
u3e = b.add("fx-fork-u3e", a2b, "user", "forkecho user turn, second child at the second fork (current). " + words(10))
a3e = b.add("fx-fork-a3e", u3e, "assistant", "forkecho answer, the currentId leaf. " + words(10))
chats.append(b.chat(a3e))

# HVN-33: chat to delete
b = ChatBuilder("fx-delete", "Fixture to delete", ts + 6000)
last = b.linear([("user", "The dodecahedron question. " + words(30)), ("assistant", words(40))])
chats.append(b.chat(last))

# HVN-65: punctuation stuck to a word. fx-punct has the word six times, each spelled differently;
# in fx-wombat-comma the only occurrence has a comma after it, in fx-wombat-plain it is bare;
# the same pair in Cyrillic.
b = ChatBuilder("fx-punct", "Fixture punctuation", ts + 7000)
last = b.linear([
    ("user", "one wombatz two wombatz, three wombatz. four wombatz; five (wombatz) six wombatz!"),
    ("assistant", words(20)),
])
chats.append(b.chat(last))
for cid, title, text in [
    ("fx-wombat-comma", "Fixture wombat comma", "I saw a wombat, then it left."),
    ("fx-wombat-plain", "Fixture wombat plain", "A wombat sat down."),
    ("fx-privet-comma", "Fixture privet comma", "Он сказал привет, и ушёл."),
    ("fx-privet-plain", "Fixture privet plain", "Привет мир."),
]:
    b = ChatBuilder(cid, title, ts + 7100)
    last = b.linear([("user", text), ("assistant", words(20))])
    chats.append(b.chat(last))

# Filler, some with an image
for i in range(N_FILLER):
    cid = f"fx-fill-{i:04d}"
    b = ChatBuilder(cid, f"Filler {i:04d}: " + " ".join(rng.choice(VOCAB) for _ in range(4)), ts + 10000 + i * 1000)
    turns = []
    for t in range(10):
        turns.append(("user" if t % 2 == 0 else "assistant", words(rng.randint(60, 180))))
    if i % 30 == 0:  # 10 image chats at 300
        mid0 = f"{cid}-m0"
        turns[0] = ("user", ["Here is a picture. " + words(20), {"kind": "binary", "data": "placeholder", "media_type": "image/png"}])
        media.append((f"media/{cid}/0_image.png", cid, mid0, 0, png(48, 32, (rng.randrange(256), rng.randrange(256), rng.randrange(256)))))
    last = b.linear(turns)
    chats.append(b.chat(last))

# HVN-59: a link whose text and URL both contain "https"
b = ChatBuilder("fx-links", "Fixture links https", ts + 8000)
last = b.linear([("user", "Show me the https link. " + words(10)), ("assistant", "Here: [https://example.test/docs](https://example.test/docs) and the plain https://example.test/plain address.")])
chats.append(b.chat(last))

manifest = {
    "haevn_version": "fixture", "export_version": "1.0", "export_id": "fixture",
    "export_timestamp": iso(BASE_TS), "total_chats": len(chats), "total_media_items": len(media),
    "total_size_bytes": 0, "provider_stats": {"claude": len(chats)},
    "chats": [{"id": c["id"], "source": c["source"], "sourceId": c["sourceId"], "file": f"chats/{c['id']}.json"} for c in chats],
    "media": [{"path": p, "chatId": c, "messageId": m, "partIndex": k, "mediaType": "image/png", "size": len(d)} for p, c, m, k, d in media],
}
zpath = os.path.join(OUT, "fixtures.zip")
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("manifest.json", json.dumps(manifest))
    for c in chats:
        z.writestr(f"chats/{c['id']}.json", json.dumps(c))
    for p, _, _, _, d in media:
        z.writestr(p, d)

b = ChatBuilder("fx-late", "Fixture late chat", ts + 9_000_000)
last = b.linear([("user", "The kumquatine arrived during the rebuild. " + words(30)), ("assistant", words(30))])
with open(os.path.join(OUT, "late_chat.json"), "w") as f:
    json.dump(b.chat(last), f)

print(f"{zpath}: {len(chats)} chats, {len(media)} media, {os.path.getsize(zpath)} bytes")
