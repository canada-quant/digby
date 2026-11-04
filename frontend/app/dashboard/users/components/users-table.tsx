'use client';

import { useState } from 'react';
import { UsersListResponse, User } from '@/lib/api/users';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { UserRowActions } from './user-row-actions';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';

interface UsersTableProps {
  data?: UsersListResponse;
  isLoading: boolean;
  onPageChange: (page: number) => void;
  onRefetch: () => void;
}

export function UsersTable({ data, isLoading, onPageChange, onRefetch }: UsersTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!data || data.users.length === 0) {
    return (
      <div className="text-center py-12 border rounded-lg">
        <p className="text-muted-foreground">No users found</p>
      </div>
    );
  }

  const { users, pagination } = data;

  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        {/* min-w keeps the 6 columns readable and lets the Table's overflow-x-auto
            wrapper scroll horizontally on narrow screens instead of squishing. */}
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Stats</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right whitespace-nowrap">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.name}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>
                  <Badge variant={user.role === 'ADMIN' ? 'default' : 'secondary'}>
                    {user.role}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="text-sm text-muted-foreground space-y-1">
                    {user._count && (
                      <>
                        <div>{user._count.aiChats} chats</div>
                        <div>{user._count.content} content</div>
                        <div>{user._count.crmContacts} contacts</div>
                      </>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">
                    {format(new Date(user.createdAt), 'MMM d, yyyy')}
                  </div>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <UserRowActions user={user} onSuccess={onRefetch} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Showing {(pagination.page - 1) * pagination.limit + 1} to{' '}
          {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} users
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(pagination.page - 1)}
            disabled={pagination.page === 1}
          >
            <ChevronLeft className="size-4" />
            Previous
          </Button>
          <div className="text-sm">
            Page {pagination.page} of {pagination.pages}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(pagination.page + 1)}
            disabled={pagination.page === pagination.pages}
          >
            Next
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
