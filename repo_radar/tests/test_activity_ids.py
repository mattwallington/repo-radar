from repo_radar.activity import ids

def test_mint_activity_id_is_valid_uuid4():
    for _ in range(50):
        aid = ids.mint_activity_id()
        assert ids.valid_activity_id(aid)

def test_valid_activity_id_rejects_non_v4_and_path_tricks():
    assert not ids.valid_activity_id("")
    assert not ids.valid_activity_id("../etc/passwd")
    assert not ids.valid_activity_id("XABCDEF0-0000-4000-8000-000000000000")  # non-hex
    assert not ids.valid_activity_id("00000000-0000-1000-8000-000000000000")  # version 1
    assert not ids.valid_activity_id("00000000-0000-4000-7000-000000000000")  # variant 7
    assert ids.valid_activity_id("00000000-0000-4000-8000-000000000000")

def test_mint_token_and_validation():
    for _ in range(50):
        t = ids.mint_token()
        assert ids.valid_token(t)
    assert not ids.valid_token("deadbeef0")   # 9 chars
    assert not ids.valid_token("DEADBEEF")    # uppercase
    assert not ids.valid_token("../foo")
