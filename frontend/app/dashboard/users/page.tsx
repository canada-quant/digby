'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usersApi, UsersQueryParams } from '@/lib/api/users';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UsersTable } from './components/users-table';
import { CreateUserDialog } from './components/create-user-dialog';
import { UserPlus, Search } from 'lucide-react';
import { useDebounce } from '@/hooks/use-debounce';

export default function UsersPage() {
  const [queryParams, setQueryParams] = useState<UsersQueryParams>({
    page: 1,
    limit: 10,
  });
  const [search, setSearch] = useState('');
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  
  const debouncedSearch = useDebounce(search, 500);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['users', { ...queryParams, search: debouncedSearch }],
    queryFn: () => usersApi.list({ ...queryParams, search: debouncedSearch }),
  });

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setQueryParams({ ...queryParams, page: 1 });
  };

  const handlePageChange = (page: number) => {
    setQueryParams({ ...queryParams, page });
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Users</h1>
          <p className="text-muted-foreground">
            Manage user accounts and permissions
          </p>
        </div>
        <Button onClick={() => setIsCreateDialogOpen(true)}>
          <UserPlus className="mr-2 size-4" />
          Add User
        </Button>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground size-4" />
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <UsersTable
        data={data}
        isLoading={isLoading}
        onPageChange={handlePageChange}
        onRefetch={refetch}
      />

      <CreateUserDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        onSuccess={refetch}
      />
    </div>
  );
}
