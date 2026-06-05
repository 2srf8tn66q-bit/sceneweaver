import Workbench from "@/components/Workbench";

export default async function WorkbenchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <Workbench id={id} />;
}
