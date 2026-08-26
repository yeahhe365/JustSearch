"""第二轮审计修复：Docker bridge 网关信任规则的容器化门禁。

规则动机：Docker 发布端口场景下，宿主机→容器的连接在容器内表现为 bridge
网关 IP（x.x.x.1）。该前提只在"运行于容器内"时成立——裸机部署上任何恰好
以 x.x.x.1 为源地址的局域网/VPC 机器（真实路由器、VPC 网关）都不该被免
token 信任。
"""

import asyncio
import ipaddress

from backend.app import auth


class _FakeClient:
    def __init__(self, host):
        self.host = host


class _FakeRequest:
    def __init__(self, client_host, headers=None):
        self.client = _FakeClient(client_host) if client_host is not None else None
        self.headers = headers or {}
        self.query_params = {}


def _patch_container(monkeypatch, in_container: bool):
    monkeypatch.setattr(auth, "_running_in_container", lambda: in_container)


# ---------------------------------------------------------------------------
# _is_docker_bridge_gateway 受容器检测门禁
# ---------------------------------------------------------------------------


def test_gateway_ip_not_trusted_on_bare_host(monkeypatch):
    _patch_container(monkeypatch, in_container=False)
    assert auth._is_docker_bridge_gateway(ipaddress.ip_address("172.17.0.1")) is False
    assert auth._is_docker_bridge_gateway(ipaddress.ip_address("10.0.0.1")) is False


def test_gateway_ip_trusted_inside_container(monkeypatch):
    _patch_container(monkeypatch, in_container=True)
    assert auth._is_docker_bridge_gateway(ipaddress.ip_address("172.17.0.1")) is True
    assert auth._is_docker_bridge_gateway(ipaddress.ip_address("10.0.0.1")) is True


def test_non_gateway_ips_unaffected_by_gate(monkeypatch):
    # .2 结尾的普通容器地址、公网地址在任何模式下都不可信；回环不受影响。
    _patch_container(monkeypatch, in_container=True)
    assert auth._is_docker_bridge_gateway(ipaddress.ip_address("172.17.0.2")) is False
    assert auth._is_docker_bridge_gateway(ipaddress.ip_address("8.8.8.8")) is False
    assert auth._is_trusted_local_client("127.0.0.1") is True
    _patch_container(monkeypatch, in_container=False)
    assert auth._is_trusted_local_client("127.0.0.1") is True


# ---------------------------------------------------------------------------
# _running_in_container 检测顺序：显式环境变量 > /.dockerenv
# ---------------------------------------------------------------------------


def test_running_in_container_env_overrides_dockerenv(monkeypatch, tmp_path):
    fake_env = tmp_path / ".dockerenv"
    fake_env.write_text("")
    monkeypatch.setattr(auth.Path, "exists", lambda self: str(self) == "/.dockerenv")
    monkeypatch.setenv("JUSTSEARCH_TRUST_BRIDGE_GATEWAY", "0")
    assert auth._running_in_container() is False  # 显式关闭压过 /.dockerenv 存在
    monkeypatch.setenv("JUSTSEARCH_TRUST_BRIDGE_GATEWAY", "1")
    assert auth._running_in_container() is True
    monkeypatch.delenv("JUSTSEARCH_TRUST_BRIDGE_GATEWAY")
    # /.dockerenv 不存在 → 默认裸机。
    monkeypatch.setattr(auth.Path, "exists", lambda self: False)
    assert auth._running_in_container() is False


# ---------------------------------------------------------------------------
# 端到端：免 token 双门槛在裸机/容器两种模式下的行为差异
# ---------------------------------------------------------------------------


def test_http_request_authorization_gateway_scenarios(monkeypatch):
    """Host 回环 + 网关源 IP：容器内放行、裸机要求 token。"""
    token = "unit-test-token"

    def scenario(in_container: bool):
        _patch_container(monkeypatch, in_container=in_container)

        gateway_req = _FakeRequest(
            "172.17.0.1",
            {"host": "localhost:8000"},  # 无 Origin 头（同站导航）
        )
        loopback_req = _FakeRequest(
            "127.0.0.1",
            {"host": "localhost:8000"},
        )
        evil_host_req = _FakeRequest(
            "172.17.0.1",
            {"host": "evil.example.com"},
        )

        return (
            auth.is_http_request_authorized(gateway_req, token_provider=lambda: token),
            auth.is_http_request_authorized(loopback_req, token_provider=lambda: token),
            auth.is_http_request_authorized(evil_host_req, token_provider=lambda: token),
            auth.is_http_request_authorized(evil_host_req, token_provider=lambda: token)
            if False else None,
        )

    container_gateway, container_loopback, container_evil_no_token, _ = scenario(True)
    assert container_gateway is True          # 容器内：宿主机经发布端口访问放行
    assert container_loopback is True         # 回环始终放行
    assert container_evil_no_token is False   # Host 非回环必须带正确 token

    bare_gateway, bare_loopback, bare_evil_no_token, _ = scenario(False)
    assert bare_gateway is False              # 裸机：网关源 IP 不再被免 token 信任
    assert bare_loopback is True
    assert bare_evil_no_token is False

    # 裸机上带正确 token 的网关请求仍然放行。
    _patch_container(monkeypatch, in_container=False)
    req = _FakeRequest("172.17.0.1", {"host": "evil.example.com", "authorization": f"Bearer {token}"})
    assert auth.is_http_request_authorized(req, token_provider=lambda: token) is True


# ---------------------------------------------------------------------------
# Docker 健康检查路径不受影响：curl 来自容器内回环
# ---------------------------------------------------------------------------


def test_healthcheck_loopback_flow_unchanged(monkeypatch):
    _patch_container(monkeypatch, in_container=False)  # 即便判定为裸机也不影响真回环
    req = _FakeRequest("127.0.0.1", {"host": "localhost:8000"})
    assert auth.is_http_request_authorized(req, token_provider=lambda: "t") is True
