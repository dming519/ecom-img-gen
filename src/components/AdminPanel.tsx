"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAdminUsers, updateAdminUser } from "@/lib/api";
import type { AdminUserRow } from "@/lib/types";

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

export default function AdminPanel({ open, onClose }: AdminPanelProps) {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchAdminUsers();
      setUsers(payload.users);
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

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
    patch: { remainingCredits?: number; role?: "admin" | "user" },
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
          <button className="btn-ghost" type="button" onClick={loadUsers} disabled={loading}>
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
                return (
                  <tr key={user.userKey}>
                    <td>
                      <div className="admin-user-cell">
                        {user.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={user.image} alt={user.name} />
                        ) : (
                          <span>{user.name.slice(0, 1).toUpperCase()}</span>
                        )}
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
                        disabled={busy}
                        onChange={(event) =>
                          updateUser(user, { role: event.target.value as "admin" | "user" })
                        }
                      >
                        <option value="user">用户</option>
                        <option value="admin">管理员</option>
                      </select>
                    </td>
                    <td>
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
                    </td>
                    <td>{user.usedCredits}</td>
                    <td>{new Date(user.lastLoginAt).toLocaleString("zh-CN", TIME_FMT)}</td>
                    <td>
                      <button
                        className="btn-ghost"
                        type="button"
                        disabled={busy}
                        onClick={() => updateUser(user, { remainingCredits: user.remainingCredits + 5 })}
                      >
                        +5
                      </button>
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
      </section>
    </div>
  );
}
