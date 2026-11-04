'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { usersApi, User } from '@/lib/api/users';
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
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

interface ChangeRoleDialogProps {
  user: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function ChangeRoleDialog({ user, open, onOpenChange, onSuccess }: ChangeRoleDialogProps) {
  const [role, setRole] = useState<'ADMIN' | 'USER'>(user.role);

  const changeRoleMutation = useMutation({
    mutationFn: (newRole: 'ADMIN' | 'USER') => usersApi.changeRole(user.id, newRole),
    onSuccess: (data) => {
      toast.success(data.message);
      onOpenChange(false);
      onSuccess();
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to change user role');
    },
  });

  const handleSubmit = () => {
    if (role === user.role) {
      toast.info('Role is unchanged');
      return;
    }
    changeRoleMutation.mutate(role);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Change User Role</DialogTitle>
          <DialogDescription>
            Change the role for <strong>{user.name}</strong>. This will affect their permissions immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="role">Role</Label>
            <Select value={role} onValueChange={(value: 'ADMIN' | 'USER') => setRole(value)}>
              <SelectTrigger id="role">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USER">User</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              Current role: <strong>{user.role}</strong>
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={changeRoleMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={changeRoleMutation.isPending || role === user.role}
          >
            {changeRoleMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Change Role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
