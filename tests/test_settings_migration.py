import pytest
from backend.app.providers import (
    migrate_legacy_models,
    normalize_available_models,
    validate_available_models,
)


def test_migrate_legacy_model_id_to_available_models():
    legacy = {
        "providers": [
            {"id": "openai", "model_id": "gpt-4, gpt-3.5"},
            {"id": "deepseek", "model_id": "deepseek-chat"},
        ]
    }
    result = migrate_legacy_models(legacy)
    assert "available_models" in result
    assert len(result["available_models"]) == 3
    assert result["available_models"][0] == {
        "id": "gpt-4",
        "name": "gpt-4",
        "isPinned": False,
        "providerId": "openai",
    }
    assert result["available_models"][1]["id"] == "gpt-3.5"
    assert result["available_models"][2]["providerId"] == "deepseek"


def test_migrate_handles_display_name():
    legacy = {"providers": [{"id": "openai", "model_id": "gpt-4::My GPT4, gpt-3.5"}]}
    result = migrate_legacy_models(legacy)
    assert result["available_models"][0]["name"] == "My GPT4"
    assert result["available_models"][0]["id"] == "gpt-4"


def test_migrate_noop_when_available_models_exists():
    settings = {
        "providers": [{"id": "openai", "model_id": "gpt-4"}],
        "available_models": [{"id": "gpt-4", "name": "GPT-4", "isPinned": True, "providerId": "openai"}],
    }
    result = migrate_legacy_models(settings)
    assert len(result["available_models"]) == 1
    assert result["available_models"][0]["isPinned"] is True


def test_normalize_filters_empty():
    models = [
        {"id": "  ", "name": "bad", "providerId": "openai"},
        {"id": "gpt-4", "name": "GPT-4", "providerId": "openai"},
    ]
    result = normalize_available_models(models)
    assert len(result) == 1
    assert result[0]["id"] == "gpt-4"


def test_validate_duplicate():
    models = [
        {"id": "gpt-4", "providerId": "openai"},
        {"id": "gpt-4", "providerId": "openai"},
    ]
    result = validate_available_models(models)
    assert not result["ok"]
    assert "duplicate" in result["message"].lower() or "重复" in result["message"]


def test_validate_ok():
    models = [
        {"id": "gpt-4", "providerId": "openai"},
        {"id": "gpt-4", "providerId": "deepseek"},
    ]
    result = validate_available_models(models)
    assert result["ok"]
