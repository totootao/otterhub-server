import { useEffect, useState } from "react";
import { format } from "date-fns";
import { Loader2, Trash2, Copy, RefreshCw, Inbox } from "lucide-react";
import { toast } from "sonner";

import { shareApi } from "@/lib/api";
import { ShareListItem } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatFileSize } from "@/lib/utils";

export function ShareTab() {
  const [shares, setShares] = useState<ShareListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string[]>([]);

  const fetchShares = async () => {
    setLoading(true);
    try {
      setShares(await shareApi.list());
    } catch {
      toast.error("获取分享失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchShares(); }, []);

  const handleRevoke = async (token: string) => {
    setRevoking((v) => [...v, token]);
    try {
      await shareApi.revoke(token);
      setShares((v) => v.filter((s) => s.token !== token));
      toast.success("分享已撤销");
    } catch {
      toast.error("撤销失败");
    } finally {
      setRevoking((v) => v.filter((t) => t !== token));
    }
  };

  const handleCopy = (token: string) => {
    navigator.clipboard.writeText(`${location.origin}/s?k=${token}`);
    toast.success("链接已复制");
  };

  const renderRows = () => {
    if (loading) return (
      <TableRow><TableCell colSpan={5} className="h-32 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground/50" /></TableCell></TableRow>
    );

    if (!shares.length) return (
      <TableRow><TableCell colSpan={5} className="h-32 text-center text-muted-foreground"><div className="flex flex-col items-center justify-center gap-2"><Inbox className="h-8 w-8 text-muted-foreground/30" /><span>暂无活跃分享</span></div></TableCell></TableRow>
    );

    return shares.map((s) => {
      const isBundle = s.type === 'bundle';
      const isExpired = s.expiresAt && s.expiresAt < Date.now();
      const isRevoking = revoking.includes(s.token);
      const displayName = isBundle ? (s.bundleName || `share-${s.token.slice(0, 8)}`) : s.fileName;

      return (
        <TableRow key={s.token} className="group transition-colors">
          <TableCell>
            <div className="flex flex-col gap-1">
              <span className="truncate max-w-[200px] font-medium" title={displayName}>{displayName}</span>
              <span className="text-xs text-muted-foreground">{formatFileSize(isBundle ? s.totalSize : s.fileSize)}</span>
            </div>
          </TableCell>
          <TableCell>
            <Badge variant="outline" className="whitespace-nowrap w-fit">
              {isBundle ? s.files.length : 1} 个文件
            </Badge>
          </TableCell>
          <TableCell className="text-muted-foreground whitespace-nowrap text-sm">
            {format(s.createdAt, "yyyy-MM-dd HH:mm")}
          </TableCell>
          <TableCell className="whitespace-nowrap text-sm">
            {isExpired ? <span className="text-destructive font-medium">已过期</span> : <span className="text-muted-foreground">{s.expiresAt ? format(s.expiresAt, "yyyy-MM-dd HH:mm") : "永久有效"}</span>}
          </TableCell>
          <TableCell className="text-right">
            <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity focus-within:opacity-100 sm:opacity-100">
              <Button size="icon" variant="ghost" onClick={() => handleCopy(s.token)} title="复制链接"><Copy className="h-4 w-4" /></Button>
              <Button size="icon" variant="ghost" disabled={isRevoking} onClick={() => handleRevoke(s.token)} className="text-destructive hover:bg-destructive/10" title="撤销分享">
                {isRevoking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </Button>
            </div>
          </TableCell>
        </TableRow>
      );
    });
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">分享链接</h2>
          <p className="text-sm text-muted-foreground">管理当前活跃的文件分享链接</p>
        </div>
        <Button size="sm" variant="secondary" onClick={fetchShares} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> 刷新
        </Button>
      </div>

      <div className="flex-1 overflow-hidden rounded-lg border bg-background shadow-sm">
        <div className="h-full overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted/50 backdrop-blur">
              <TableRow>
                <TableHead>文件</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>过期时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{renderRows()}</TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}