"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  createAccessCode,
  createRedeemCode,
  fetchAccessCodes,
  fetchAdminUsers,
  fetchRedeemCodes,
  updateAccessCode,
  updateAdminUser,
  updateRedeemCode,
} from "@/lib/api";
import type { AccessCodeRow, AdminUserRow, RedeemCodeRow, UserRole } from "@/lib/types";

interface AdminPanelProps {
  open: boolean;
  onClose: () => void;
}

const TIME_FMT: Intl.DateTimeFormatOptions = {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "超级管理员",
  admin: "管理员",
  user: "用户",
};

function AdminAvatar({ user }: { user: AdminUserRow }) {
  const [failed, setFailed] = useState(false);
  if (user.image && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={user.image} alt={user.name} onError={() => setFailed(true)} />
    );
  }
  return <span>{user.name.slice(0, 1).toUpperCase()}</span>;
}

export default function AdminPanel({ open, onClose }: AdminPanelProps) {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [accessCodes, setAccessCodes] = useState<AccessCodeRow[]>([]);
  const [redeemCodes, setRedeemCodes] = useState<RedeemCodeRow[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [accessBusy, setAccessBusy] = useState(false);
  const [redeemBusy, setRedeemBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accessLabel, setAccessLabel] = useState("");
  const [customCode, setCustomCode] = useState("");
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [redeemLabel, setRedeemLabel] = useState("");
  const [customRedeemCode, setCustomRedeemCode] = useState("");
  const [redeemCredits, setRedeemCredits] = useState(5);
  const [redeemMaxUses, setRedeemMaxUses] = useState(1);
  const [createdRedeemCode, setCreatedRedeemCode] = useState<string | null>(null);

  const loadAdminData = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const [userPayload, codePayload, redeemPayload] = await Promise.all([
        fetchAdminUsers(),
        fetchAccessCodes(),
        fetchRedeemCodes(),
      ]);
      setUsers(userPayload.users);
      setAccessCodes(codePayload.accessCodes);
      setRedeemCodes(redeemPayload.redeemCodes);
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    loadAdminData();
  }, [loadAdminData]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const updateUser = async (
    user: AdminUserRow,
    patch: { remainingCredits?: number; role?: UserRole },
  ) => {
    setBusyKey(user.userKey);
    setError(null);
    try {
      const payload = await updateAdminUser(user.userKey, patch);
      setUsers((previous) =>
        previous.map((item) => (item.userKey === user.userKey ? payload.user : item)),
      );
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      setBusyKey(null);
    }
  };

  const handleCreateAccessCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAccessBusy(true);
    setError(null);
    setCreatedCode(null);
    try {
      const payload = await createAccessCode(accessLabel, customCode);
      setAccessCodes((previous) => [payload.accessCode, ...previous]);
      setCreatedCode(payload.code);
      setAccessLabel("");
      setCustomCode("");
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      setAccessBusy(false);
    }
  };

  const handleUpdateAccessCode = async (
    accessCode: AccessCodeRow,
    patch: { active?: boolean; label?: string },
  ) => {
    setBusyKey(accessCode.id);
    setError(null);
    try {
      const payload = await updateAccessCode(accessCode.id, patch);
      setAccessCodes((previous) =>
        previous.map((item) => (item.id === accessCode.id ? payload.accessCode : item)),
      );
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      setBusyKey(null);
    }
  };

  const handleCreateRedeemCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRedeemBusy(true);
    setError(null);
    setCreatedRedeemCode(null);
    try {
      const payload = await createRedeemCode(
        redeemLabel,
        redeemCredits,
        redeemMaxUses,
        customRedeemCode,
      );
      setRedeemCodes((previous) => [payload.redeemCode, ...previous]);
      setCreatedRedeemCode(payload.code);
      setRedeemLabel("");
      setCustomRedeemCode("");
      setRedeemCredits(5);
      setRedeemMaxUses(1);
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      setRedeemBusy(false);
    }
  };

  const handleUpdateRedeemCode = async (
    redeemCode: RedeemCodeRow,
    patch: { active?: boolean; label?: string },
  ) => {
    setBusyKey(redeemCode.id);
    setError(null);
    try {
      const payload = await updateRedeemCode(redeemCode.id, patch);
      setRedeemCodes((previous) =>
        previous.map((item) => (item.id === redeemCode.id ? payload.redeemCode : item)),
      );
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      setBusyKey(null);
    }
  };

  if (!open) return null;

  return (
    <div className="admin-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <section className="admin-panel" role="dialog" aria-modal="true" aria-label="后台用户管理">
        <div className="admin-head">
          <div>
            <span className="section-kicker">Admin</span>
            <h2>用户与次数</h2>
          </div>
          <button className="btn-ghost" type="button" onClick={onClose}>
            关闭
          </button>
        </div>

        {error && <div className="alert">{error}</div>}

        <div className="admin-toolbar">
          <span>{loading ? "读取中" : `${users.length} 个用户`}</span>
          <button className="btn-ghost" type="button" onClick={loadAdminData} disabled={loading}>
            刷新
          </button>
        </div>

        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>来源</th>
                <th>角色</th>
                <th>剩余</th>
                <th>已用</th>
                <th>最近登录</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const busy = busyKey === user.userKey;
                const isSuperAdmin = user.role === "super_admin";
                return (
                  <tr key={user.userKey}>
                    <td>
                      <div className="admin-user-cell">
                        <AdminAvatar user={user} />
                        <div>
                          <strong>{user.name}</strong>
                          <small>{user.email || user.userKey}</small>
                        </div>
                      </div>
                    </td>
                    <td>{user.provider}</td>
                    <td>
                      <select
                        aria-label={`${user.name} 的角色`}
                        value={user.role}
                        disabled={busy || isSuperAdmin}
                        onChange={(event) =>
                          updateUser(user, { role: event.target.value as UserRole })
                        }
                        title={ROLE_LABELS[user.role]}
                      >
                        {isSuperAdmin && <option value="super_admin">超级管理员</option>}
                        <option value="user">用户</option>
                        <option value="admin">管理员</option>
                      </select>
                    </td>
                    <td>
                      {isSuperAdmin ? (
                        <span className="unlimited-pill">不限</span>
                      ) : (
                        <input
                          aria-label={`${user.name} 的剩余次数`}
                          type="number"
                          min={0}
                          value={user.remainingCredits}
                          disabled={busy}
                          onChange={(event) => {
                            const nextValue = Number(event.target.value) || 0;
                            setUsers((previous) =>
                              previous.map((item) =>
                                item.userKey === user.userKey
                                  ? { ...item, remainingCredits: nextValue }
                                  : item,
                              ),
                            );
                          }}
                          onBlur={(event) =>
                            updateUser(user, { remainingCredits: Number(event.target.value) || 0 })
                          }
                        />
                      )}
                    </td>
                    <td>{user.usedCredits}</td>
                    <td>{new Date(user.lastLoginAt).toLocaleString("zh-CN", TIME_FMT)}</td>
                    <td>
                      {isSuperAdmin ? (
                        <span className="admin-muted-action">无需调整</span>
                      ) : (
                        <button
                          className="btn-ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => updateUser(user, { remainingCredits: user.remainingCredits + 5 })}
                        >
                          +5
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!users.length && !loading && (
                <tr>
                  <td colSpan={7}>暂无用户数据</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <section className="access-code-section">
          <div className="admin-section-head">
            <div>
              <h3>访问码</h3>
              <p>创建给临时用户使用的登录码，创建后明文只显示一次。</p>
            </div>
            <span>{accessCodes.length} 个访问码</span>
          </div>

          <form className="access-code-form" onSubmit={handleCreateAccessCode}>
            <input
              type="text"
              value={accessLabel}
              onChange={(event) => setAccessLabel(event.target.value)}
              placeholder="备注，例如：运营同事 / 临时演示"
              aria-label="访问码备注"
            />
            <input
              type="text"
              value={customCode}
              onChange={(event) => setCustomCode(event.target.value)}
              placeholder="自定义访问码，可留空自动生成"
              aria-label="自定义访问码"
            />
            <button className="btn-secondary" type="submit" disabled={accessBusy}>
              {accessBusy ? "创建中..." : "创建访问码"}
            </button>
          </form>

          {createdCode && (
            <div className="access-code-created">
              <span>新访问码</span>
              <code>{createdCode}</code>
              <button
                className="btn-ghost"
                type="button"
                onClick={() => navigator.clipboard?.writeText(createdCode)}
              >
                复制
              </button>
            </div>
          )}

          <div className="admin-table-wrap">
            <table className="admin-table access-code-table">
              <thead>
                <tr>
                  <th>备注</th>
                  <th>状态</th>
                  <th>使用次数</th>
                  <th>最近使用</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {accessCodes.map((accessCode) => {
                  const busy = busyKey === accessCode.id;
                  return (
                    <tr key={accessCode.id}>
                      <td>
                        <input
                          aria-label="访问码备注"
                          type="text"
                          value={accessCode.label}
                          disabled={busy}
                          onChange={(event) => {
                            const label = event.target.value;
                            setAccessCodes((previous) =>
                              previous.map((item) =>
                                item.id === accessCode.id ? { ...item, label } : item,
                              ),
                            );
                          }}
                          onBlur={(event) =>
                            handleUpdateAccessCode(accessCode, { label: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <span className={`access-code-status${accessCode.active ? " is-active" : ""}`}>
                          {accessCode.active ? "启用" : "停用"}
                        </span>
                      </td>
                      <td>{accessCode.useCount}</td>
                      <td>
                        {accessCode.lastUsedAt
                          ? new Date(accessCode.lastUsedAt).toLocaleString("zh-CN", TIME_FMT)
                          : "未使用"}
                      </td>
                      <td>{new Date(accessCode.createdAt).toLocaleString("zh-CN", TIME_FMT)}</td>
                      <td>
                        <button
                          className="btn-ghost"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            handleUpdateAccessCode(accessCode, { active: !accessCode.active })
                          }
                        >
                          {accessCode.active ? "停用" : "启用"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!accessCodes.length && !loading && (
                  <tr>
                    <td colSpan={6}>暂无访问码</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="access-code-section redeem-code-section">
          <div className="admin-section-head">
            <div>
              <h3>兑换码</h3>
              <p>创建给已登录用户使用的次数兑换码，创建后明文只显示一次。</p>
            </div>
            <span>{redeemCodes.length} 个兑换码</span>
          </div>

          <form className="access-code-form redeem-code-form" onSubmit={handleCreateRedeemCode}>
            <input
              type="text"
              value={redeemLabel}
              onChange={(event) => setRedeemLabel(event.target.value)}
              placeholder="备注，例如：活动赠送 / 老客补偿"
              aria-label="兑换码备注"
            />
            <input
              type="text"
              value={customRedeemCode}
              onChange={(event) => setCustomRedeemCode(event.target.value)}
              placeholder="自定义兑换码，可留空自动生成"
              aria-label="自定义兑换码"
            />
            <input
              type="number"
              min={1}
              max={999}
              value={redeemCredits}
              onChange={(event) => setRedeemCredits(Number(event.target.value) || 1)}
              aria-label="每次增加次数"
            />
            <input
              type="number"
              min={1}
              max={10000}
              value={redeemMaxUses}
              onChange={(event) => setRedeemMaxUses(Number(event.target.value) || 1)}
              aria-label="可兑换次数"
            />
            <button className="btn-secondary" type="submit" disabled={redeemBusy}>
              {redeemBusy ? "创建中..." : "创建兑换码"}
            </button>
          </form>

          {createdRedeemCode && (
            <div className="access-code-created">
              <span>新兑换码</span>
              <code>{createdRedeemCode}</code>
              <button
                className="btn-ghost"
                type="button"
                onClick={() => navigator.clipboard?.writeText(createdRedeemCode)}
              >
                复制
              </button>
            </div>
          )}

          <div className="admin-table-wrap">
            <table className="admin-table access-code-table">
              <thead>
                <tr>
                  <th>备注</th>
                  <th>状态</th>
                  <th>次数</th>
                  <th>兑换进度</th>
                  <th>最近兑换</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {redeemCodes.map((redeemCode) => {
                  const busy = busyKey === redeemCode.id;
                  return (
                    <tr key={redeemCode.id}>
                      <td>
                        <input
                          aria-label="兑换码备注"
                          type="text"
                          value={redeemCode.label}
                          disabled={busy}
                          onChange={(event) => {
                            const label = event.target.value;
                            setRedeemCodes((previous) =>
                              previous.map((item) =>
                                item.id === redeemCode.id ? { ...item, label } : item,
                              ),
                            );
                          }}
                          onBlur={(event) =>
                            handleUpdateRedeemCode(redeemCode, { label: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <span className={`access-code-status${redeemCode.active ? " is-active" : ""}`}>
                          {redeemCode.active ? "启用" : "停用"}
                        </span>
                      </td>
                      <td>+{redeemCode.credits}</td>
                      <td>
                        {redeemCode.redeemCount} / {redeemCode.maxRedemptions}
                      </td>
                      <td>
                        {redeemCode.lastRedeemedAt
                          ? new Date(redeemCode.lastRedeemedAt).toLocaleString("zh-CN", TIME_FMT)
                          : "未兑换"}
                      </td>
                      <td>{new Date(redeemCode.createdAt).toLocaleString("zh-CN", TIME_FMT)}</td>
                      <td>
                        <button
                          className="btn-ghost"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            handleUpdateRedeemCode(redeemCode, { active: !redeemCode.active })
                          }
                        >
                          {redeemCode.active ? "停用" : "启用"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!redeemCodes.length && !loading && (
                  <tr>
                    <td colSpan={7}>暂无兑换码</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </div>
  );
}
