// What the Workshop keeps: what main last said (mgr:state), and the robot being built.
import type { Character, Kit, RobotSize } from '@/types/model';
import type { WorkshopSettings, WorkshopState } from '@/types/pages';

// (what mgr:state said; till it first answers, these empty ones)
export type Shown = Pick<WorkshopState, 'characters' | 'personalities'> &
  Partial<Pick<WorkshopState, 'claudePath' | 'claudeSource' | 'notes' | 'hotkeys'>> & {
    permissionModes: Partial<WorkshopState['permissionModes']>;
    settings: Partial<WorkshopSettings>;
  };
// the robot being built or tuned up (what mgr:create and mgr:update get)
export type Draft = Pick<Character, 'name' | 'folder' | 'personality' | 'color' | 'permissionMode' | 'model'> & {
  accessory: string;
  body: string;
  kit: Required<Kit>;
  theme: NonNullable<Character['theme']>;
  size: RobotSize;
  clickOpens: NonNullable<Character['clickOpens']>;
  wanders: boolean;
};
