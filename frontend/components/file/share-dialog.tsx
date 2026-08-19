import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { shareApi } from '@/lib/api';
import { toast } from 'sonner';
import { Copy, Loader2 } from 'lucide-react';

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileKey: string;
  fileName: string;
}

export function ShareDialog({ open, onOpenChange, fileKey, fileName }: ShareDialogProps) {
  const [loading, setLoading] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  
  const [expireIn, setExpireIn] = useState('3600');
  const [customDays, setCustomDays] = useState('1');

  const handleCreateLink = async () => {
    let seconds: number | undefined;

    // 更简洁的参数计算逻辑
    if (expireIn === 'custom') {
      const days = parseInt(customDays, 10);
      if (!days || days < 1 || days > 365) {
        return toast.error('请输入有效的天数 (1-365)');
      }
      seconds = days * 86400;
    } else if (expireIn !== '-1') {
      seconds = parseInt(expireIn, 10);
    }

    setLoading(true);
    try {
      const { token } = await shareApi.create({ fileKey, expireIn: seconds });
      setShareLink(`${window.location.origin}/s?k=${token}`);
      toast.success('分享链接已创建');
    } catch {
      toast.error('创建分享链接失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!shareLink) return;
    navigator.clipboard.writeText(shareLink);
    toast.success('链接已复制');
  };

  const handleReset = () => {
    setShareLink(null);
    setExpireIn('3600');
    setCustomDays('1');
  };

  return (
    <Dialog open={open} onOpenChange={(val) => {
      onOpenChange(val);
      if (!val) setTimeout(handleReset, 300); // 弹窗关闭动画结束后再重置状态
    }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>分享文件</DialogTitle>
          <DialogDescription>
            为 <span className="font-medium text-foreground">{fileName}</span> 创建临时分享链接
          </DialogDescription>
        </DialogHeader>

        {!shareLink ? (
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>有效期</Label>
              <Select value={expireIn} onValueChange={setExpireIn}>
                <SelectTrigger><SelectValue placeholder="选择有效期" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="3600">1 小时</SelectItem>
                  <SelectItem value="86400">1 天</SelectItem>
                  <SelectItem value="604800">7 天</SelectItem>
                  <SelectItem value="2592000">30 天</SelectItem>
                  <SelectItem value="custom">自定义（天）</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {expireIn === 'custom' && (
              <div className="grid gap-2">
                <Label>自定义天数 (1-365)</Label>
                <Input
                  type="number"
                  value={customDays}
                  placeholder="输入天数"
                  onChange={(e) => {
                    // 正则过滤非数字(防止输入e、+、-等)，并用 Math.min/max 限制边界
                    const val = e.target.value.replace(/\D/g, ''); 
                    if (!val) return setCustomDays('');
                    const clampedVal = Math.min(Math.max(parseInt(val, 10), 1), 365);
                    setCustomDays(clampedVal.toString());
                  }}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 py-4">
            <Input value={shareLink} readOnly />
            <Button size="icon" onClick={handleCopy} title="复制链接">
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <div className="flex w-full justify-end gap-2">
            {!shareLink ? (
              <>
                <Button variant="secondary" onClick={() => onOpenChange(false)}>取消</Button>
                <Button onClick={handleCreateLink} disabled={loading}>
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  创建链接
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={handleReset}>继续分享</Button>
                <Button onClick={() => onOpenChange(false)}>完成</Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}