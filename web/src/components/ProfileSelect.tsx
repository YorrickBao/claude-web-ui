import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { listProfiles } from "@/lib/api";
import type { EnvProfile } from "@/lib/types";
import { ProfileManagerModal } from "@/components/ProfileManagerModal";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * 选 profile 的下拉。
 * 用法：value = 当前选中的 profileId（null = 不绑定），
 *      onChange = 切换回调。
 *
 * 旁边带个齿轮按钮快速打开管理 modal。
 */
export interface ProfileSelectProps {
  value: string | null;
  onChange: (profileId: string | null) => void;
  /** "none" 选项的显示文字（默认"不绑定 · CLI 默认"） */
  noneLabel?: string;
}

export function ProfileSelect({
  value,
  onChange,
  noneLabel = "不绑定 · CLI 默认",
}: ProfileSelectProps) {
  const [profiles, setProfiles] = useState<EnvProfile[]>([]);
  const [mgrOpen, setMgrOpen] = useState(false);

  const refresh = () => {
    listProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  };

  useEffect(refresh, []);

  // 如果当前选中的 profile 被删了（列表已加载完且不含 value），自动回退到 null。
  // 注意：profiles 还没加载（空数组）时不要触发，否则会话创建瞬间会误清空。
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  useEffect(() => {
    if (profilesLoaded && value && !profiles.some((p) => p.id === value)) {
      onChange(null);
    }
  }, [value, profiles, profilesLoaded, onChange]);

  // 第一次 listProfiles 返回后标记 loaded（之后即使变空也认）
  useEffect(() => {
    if (!profilesLoaded && profiles.length > 0) setProfilesLoaded(true);
  }, [profiles, profilesLoaded]);

  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={value ?? ""}
        onValueChange={(v) => onChange(v || null)}
      >
        <SelectTrigger className="min-w-0 flex-1">
          <SelectValue placeholder={noneLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">{noneLabel}</SelectItem>
          {profiles.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="icon"
        onClick={() => setMgrOpen(true)}
        title="管理配置"
        className="shrink-0"
      >
        <Settings2 className="h-3.5 w-3.5" />
      </Button>
      <ProfileManagerModal
        open={mgrOpen}
        onClose={() => {
          setMgrOpen(false);
          refresh();
        }}
        onChanged={refresh}
      />
    </div>
  );
}
